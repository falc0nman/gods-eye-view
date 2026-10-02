import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import Bunzip from 'seek-bzip';
import {
  decodeLevel3,
  nexradFloat16,
  RANGE_FOLDED,
} from '../../../server/providers/nexrad/level3.js';
import { colorForValue } from './palette.js';
import {
  coverageBounds,
  encodePng,
  renderLevel3,
} from '../../../server/providers/nexrad/render.js';

const fixture = (name) =>
  readFileSync(
    new URL(
      `../../data/fixtures/level3-KTLX-${name}-20261002-0109.bin`,
      import.meta.url,
    ),
  );
const bunzip = (data) => Bunzip.decode(Buffer.from(data));
const decode = (name) => decodeLevel3(fixture(name), { bunzip });

function stats(product) {
  const values = [];
  let rf = 0;
  for (const radial of product.radials) {
    for (const level of radial.levels) {
      const v = product.valueOf(level);
      if (v === RANGE_FOLDED) rf += 1;
      else if (typeof v === 'number') values.push(v);
    }
  }
  values.sort((a, b) => a - b);
  return { n: values.length, min: values[0], max: values.at(-1), rf };
}

test("every product reads KTLX's position and the volume scan time from its header", () => {
  for (const name of ['N0S', 'N0K', 'EET']) {
    const p = decode(name);
    assert.deepEqual([p.site.lat, p.site.lon], [35.333, -97.278]);
    assert.equal(new Date(p.scanMs).toISOString(), '2026-10-02T01:09:25.000Z');
  }
});

test('N0S: run-length radials, 1° × 1 km, knots with range folding', () => {
  const p = decode('N0S');
  assert.equal(p.productCode, 56);
  assert.equal(p.elevationDeg, 0.5);
  assert.equal(p.radials.length, 360);
  assert.equal(p.bins, 230);
  const s = stats(p);
  assert.equal(s.min, -64);
  assert.equal(s.max, 50);
  assert.ok(s.rf > 0, 'range-folded gates are flagged, not given a speed');
});

test('N0K: bzip2-compressed digital radials with float scale/offset', () => {
  const p = decode('N0K');
  assert.equal(p.productCode, 163);
  assert.equal(p.bins, 1200);
  assert.equal(p.gateKm, 0.25);
  const s = stats(p);
  assert.ok(s.n > 10_000);
  assert.ok(
    s.min >= -2 && s.max <= 8,
    `KDP ${s.min}..${s.max} °/km is physical`,
  );
});

test('EET: masked echo-top levels in kft, not tied to one elevation', () => {
  const p = decode('EET');
  assert.equal(p.productCode, 135);
  assert.equal(p.elevationDeg, null);
  const s = stats(p);
  assert.ok(s.min >= 0 && s.max <= 70, `echo tops ${s.min}..${s.max} kft`);
});

test('non-Level-III input is refused, not mis-rendered', () => {
  assert.throws(
    () => decodeLevel3(new Uint8Array(200), { bunzip }),
    /unsupported|missing/,
  );
});

test('NEXRAD 16-bit floats decode as the ICD specifies', () => {
  assert.equal(nexradFloat16(0x4400), 2); // exponent 17, no fraction
  assert.equal(nexradFloat16(0xc400), -2);
  assert.equal(nexradFloat16(0x0200), 1); // denormal: fraction / 512
});

test('colour tables: thresholds, both velocity signs, classes and range folding', () => {
  assert.equal(colorForValue('ref', 0), null, 'below 5 dBZ is transparent');
  assert.deepEqual(colorForValue('ref', 50), [253, 0, 0, 255]);
  assert.ok(
    colorForValue('vel', -30)[1] > colorForValue('vel', -30)[0],
    'inbound is green',
  );
  assert.ok(
    colorForValue('vel', 30)[0] > colorForValue('vel', 30)[1],
    'outbound is red',
  );
  assert.deepEqual(colorForValue('hc', 'HA'), [255, 0, 0, 255]);
  assert.deepEqual(colorForValue('cc', RANGE_FOLDED), [128, 0, 160, 255]);
});

test('rendering keeps north up and stays inside the range circle', () => {
  const p = decode('N0S');
  const image = renderLevel3(p);
  assert.deepEqual(image.bounds, coverageBounds(p.site, 230));
  const alpha = (x, y) => image.rgba[(y * image.width + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0, 'corners are outside the radar range');
  assert.equal(alpha(image.width - 1, image.height - 1), 0);
  let painted = 0;
  for (let i = 3; i < image.rgba.length; i += 4)
    if (image.rgba[i]) painted += 1;
  assert.ok(painted > 1000);
});

test('the PNG encoder writes a valid, decodable PNG', () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255,
  ]);
  const png = encodePng(
    { width: 2, height: 2, rgba },
    {
      deflate: (d) => zlib.deflateSync(d),
      crc32: zlib.crc32,
    },
  );
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  // IDAT payload inflates back to the filtered scanlines.
  const view = new DataView(png.buffer, png.byteOffset);
  const ihdrLen = view.getUint32(8);
  const idatAt = 8 + 12 + ihdrLen;
  const idatLen = view.getUint32(idatAt);
  const raw = zlib.inflateSync(png.subarray(idatAt + 8, idatAt + 8 + idatLen));
  assert.deepEqual(
    [...raw],
    [0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)],
  );
  assert.equal(
    view.getUint32(idatAt + 8 + idatLen),
    zlib.crc32(png.subarray(idatAt + 4, idatAt + 8 + idatLen)),
  );
});

// ── Cursor readout lookup ───────────────────────────────────────────────────

import {
  beamHeightFt,
  valueAt,
} from '../../../server/providers/nexrad/level3.js';

test('valueAt returns the decoded gate under a point, matching the radials exactly', () => {
  const p = decode('N0S');
  const rad = Math.PI / 180;
  let checked = 0;
  for (const radialIndex of [0, 45, 90, 200, 300]) {
    const radial = p.radials[radialIndex];
    const az = radial.start + radial.delta / 2;
    for (const gate of [10, 60, 150]) {
      const rangeKm = (gate + 0.5) * p.gateKm;
      // Invert the same flat-earth geometry the renderer and lookup use.
      const lat = p.site.lat + (rangeKm * Math.cos(az * rad)) / (6371 * rad);
      const lon =
        p.site.lon +
        (rangeKm * Math.sin(az * rad)) / (6371 * rad * Math.cos(lat * rad));
      const hit = valueAt(p, lat, lon);
      assert.equal(hit.inRange, true);
      assert.ok(Math.abs(hit.rangeKm - rangeKm) < 0.05);
      assert.equal(hit.value, p.valueOf(radial.levels[gate]));
      checked += 1;
    }
  }
  assert.equal(checked, 15);
  assert.equal(
    valueAt(p, p.site.lat + 5, p.site.lon).inRange,
    false,
    '555 km is beyond the 230 km product',
  );
});

test('beam height follows the 4/3-earth model', () => {
  // 0.5° at 100 km: ~0.87 km from the tilt plus ~0.59 km of earth curvature.
  const ft = beamHeightFt(100, 0.5, 0);
  assert.ok(ft > 4500 && ft < 5000, `${ft} ft`);
  assert.equal(
    Math.round(beamHeightFt(0, 0.5, 1277)),
    1277,
    'at the radar it is the radar height',
  );
});
