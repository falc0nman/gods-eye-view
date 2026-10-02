import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStormAttributesIngest,
  IEM_STORM_ATTRIBUTES_URL,
  normalizeStormAttributes,
} from '../../../server/providers/stormAttributes.js';
import { createProviderRegistry } from '../../../server/providers/registry.js';
import { localProviderRegistry } from '../../../server/providers/local.js';

const VALID = '2026-10-02T21:05:35Z';
const VALID_MS = Date.parse(VALID);

/**
 * Shaped like IEM's nexrad_attr.geojson (one feature per storm cell). The
 * live feed could not be reached from the development sandbox, so this is
 * written from IEM's published field list: numbers may arrive as strings,
 * absent detections as "NONE".
 */
function sample() {
  const cell = (overrides) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-95.42, 29.48] },
    properties: {
      nexrad: 'HGX',
      storm_id: 'K2',
      azimuth: 272,
      range: 18,
      tvs: 'NONE',
      meso: 'NONE',
      posh: 0,
      poh: 0,
      max_size: 0,
      vil: 12,
      max_dbz: 54,
      max_dbz_height: 7.7,
      top: 24.1,
      drct: 168,
      sknt: 9,
      valid: VALID,
      ...overrides,
    },
  });
  return {
    type: 'FeatureCollection',
    features: [
      cell({}),
      cell({
        storm_id: 'D0',
        posh: '40',
        poh: '80',
        max_size: '1.50',
        meso: '4L',
        tvs: 'TVS',
      }),
      cell({ storm_id: 'G9', poh: 20, max_size: 0.5, tvs: 'ETVS', drct: null }),
      cell({ storm_id: 'Q4', valid: '2026-10-02T20:58:00Z' }),
      // A neighbouring radar's cell must not leak into HGX's answer.
      cell({ nexrad: 'LCH', storm_id: 'A1', tvs: 'TVS' }),
      // Junk without a position is skipped.
      { type: 'Feature', geometry: null, properties: { nexrad: 'HGX' } },
    ],
  };
}

test('IEM cells normalise to hail, TVS and the rest of the attribute table', () => {
  const out = normalizeStormAttributes(sample(), 'HGX');
  assert.equal(out.site, 'HGX');
  assert.equal(out.validTime, VALID_MS);
  assert.deepEqual(
    out.cells.map((c) => c.id),
    ['K2', 'D0', 'G9', 'Q4'],
  );
  const d0 = out.cells.find((c) => c.id === 'D0');
  assert.deepEqual(d0.hail, {
    severeProbabilityPct: 40,
    probabilityPct: 80,
    maxSizeIn: 1.5,
  });
  assert.equal(d0.tvs, 'TVS');
  assert.equal(d0.mesocyclone, '4L');
  assert.deepEqual(d0.motion, { fromDeg: 168, speedKt: 9 });
  assert.deepEqual(d0.maxReflectivity, { dbz: 54, heightKft: 7.7 });
  assert.deepEqual(
    [d0.lat, d0.lon, d0.azimuthDeg, d0.rangeNm],
    [29.48, -95.42, 272, 18],
  );

  const k2 = out.cells.find((c) => c.id === 'K2');
  assert.equal(k2.tvs, null, '"NONE" is no detection');
  assert.equal(k2.mesocyclone, null);

  assert.deepEqual(
    out.hail.map((c) => c.id),
    ['D0', 'G9'],
  );
  assert.deepEqual(
    out.tvs.map((c) => [c.id, c.tvs]),
    [
      ['D0', 'TVS'],
      ['G9', 'ETVS'],
    ],
  );
  // A missing motion component means no motion, not a zero vector.
  assert.equal(out.cells.find((c) => c.id === 'G9').motion, null);
});

test('a response that is not a FeatureCollection is refused', () => {
  assert.throws(
    () => normalizeStormAttributes({ error: 'x' }, 'HGX'),
    /Malformed/,
  );
});

function mount({ status = 200, body = sample() } = {}) {
  const requests = [];
  const now = () => VALID_MS + 90_000;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  const ingest = createStormAttributesIngest({ fetchImpl, now });
  const registry = createProviderRegistry({
    runtimeOptions: { now, onError: () => {} },
  });
  const runtime = registry.register(ingest.provider);
  let handler;
  for (const plugin of registry.plugins())
    plugin.configureServer({
      middlewares: {
        use: (path, fn) =>
          path === '/api/radar/storm-attributes' && (handler = fn),
      },
    });
  registry.health.stop();
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(code) {
          this.status = code;
        },
        end(text) {
          resolve({ status: this.status, body: JSON.parse(text) });
        },
      };
      handler({ url }, res);
    });
  return { ingest, registry, runtime, call, requests };
}

test("/api/radar/storm-attributes serves a radar's hail and TVS, with health", async () => {
  const { ingest, registry, runtime, call, requests } = mount();
  try {
    const res = await call('/?site=hgx');
    assert.equal(res.status, 200);
    assert.equal(res.body.hail.length, 2);
    assert.equal(res.body.tvs.length, 2);
    assert.equal(requests[0].url, `${IEM_STORM_ATTRIBUTES_URL}?radar=HGX`);
    assert.match(requests[0].init.headers['User-Agent'], /Gods Eye View/);

    // Within the 30 s cache, and with the same table time: no new upstream
    // request and nothing republished.
    await call('/?site=HGX');
    assert.equal(requests.length, 1);
    assert.equal(runtime.status().published, 1);
    assert.deepEqual(runtime.latest().data, {
      site: 'HGX',
      cells: 4,
      hail: 2,
      tvs: 2,
    });

    const health = registry.health
      .evaluate()
      .providers.find((p) => p.id === 'storm-attributes');
    assert.deepEqual(
      health.products.map((p) => [p.product, p.state, p.dataAgeMs]),
      [['HGX', 'healthy', 90_000]],
    );
    assert.deepEqual(ingest.watched(), ['HGX']);
  } finally {
    ingest.close();
  }
});

test('bad input and upstream failures answer clearly', async () => {
  const bad = mount();
  try {
    assert.equal((await bad.call('/?site=KHGX')).status, 400);
    assert.equal((await bad.call('/elsewhere?site=HGX')).status, 404);
    assert.equal(bad.requests.length, 0);
  } finally {
    bad.ingest.close();
  }
  const down = mount({ status: 503, body: {} });
  try {
    const res = await down.call('/?site=HGX');
    assert.equal(res.status, 502);
    assert.deepEqual(down.ingest.watched(), []);
  } finally {
    down.ingest.close();
  }
});

test('storm attributes are registered on the provider interface', () => {
  const entry = localProviderRegistry()
    .list()
    .find((e) => e.id === 'storm-attributes');
  assert.equal(entry.kind, 'provider');
  assert.equal(entry.source.name, 'Iowa Environmental Mesonet');
});
