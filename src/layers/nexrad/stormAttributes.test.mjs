import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeMesocyclones,
  decodeStormTracks,
  destination,
} from '../../../server/providers/nexrad/level3Attributes.js';
import { supplementalCuts } from '../../../server/providers/nexrad/level2Volume.js';
import {
  createLevel3Ingest,
  createLevel3Service,
  LEVEL3_PRODUCTS,
} from '../../../server/providers/nexrad.js';
import { createProviderRegistry } from '../../../server/providers/registry.js';

const fixture = (name) =>
  new Uint8Array(
    readFileSync(new URL(`../../data/fixtures/${name}`, import.meta.url)),
  );
// KHGX 2026-10-02 18:45:33Z: 21 storm cells, 7 mesocyclone circulations.
const NST = fixture('level3-KHGX-NST-20261002-1845.bin');
const NMD = fixture('level3-KHGX-NMD-20261002-1845.bin');
// KTLX on a quiet day: an NMD product with no detections.
const NMD_EMPTY = fixture('level3-KTLX-NMD-20261002-empty.bin');
const SCAN_MS = Date.parse('2026-10-02T18:45:33Z');
const NM = 1.852;

test('storm tracks: every cell with position, track, forecast and attributes', () => {
  const tracks = decodeStormTracks(NST);
  assert.equal(tracks.product, 'NST');
  assert.equal(tracks.scanMs, SCAN_MS);
  assert.deepEqual(tracks.site, { lat: 29.472, lon: -95.079, heightFt: 115 });
  assert.deepEqual(tracks.averageMotion, { fromDeg: 136, speedKt: 3 });
  assert.equal(tracks.cells.length, 21); // "NUMBER OF STORM CELLS 21"

  const d0 = tracks.cells.find((c) => c.id === 'D0');
  // The table says 231°/52 nm.
  assert.ok(Math.abs(d0.azimuthDeg - 231) < 1);
  assert.ok(Math.abs(d0.rangeKm / NM - 52) < 1);
  assert.deepEqual(d0.motion, { fromDeg: 176, speedKt: 7 });
  assert.deepEqual(
    d0.forecast.map((f) => f.minutes),
    [15, 30, 45, 60],
  );
  // Moving from 176°: the forecast heads north.
  assert.ok(d0.forecast.at(-1).lat > d0.lat);
  assert.equal(d0.past.length, 8);
  assert.deepEqual(d0.errorNm, { forecast: 1, mean: 0.8 });
  assert.deepEqual(d0.maxReflectivity, { dbz: 54, heightKft: 8.8 });

  const k2 = tracks.cells.find((c) => c.id === 'K2');
  assert.ok(Math.abs(k2.azimuthDeg - 272) < 1);
  assert.ok(Math.abs(k2.rangeKm / NM - 18) < 1);

  // New cells have no movement or forecast yet.
  const b4 = tracks.cells.find((c) => c.id === 'B4');
  assert.equal(b4.isNew, true);
  assert.equal(b4.motion, null);
  assert.deepEqual(b4.forecast, []);
  assert.equal(
    tracks.cells.filter((c) => c.isNew).length,
    6, // B4 M0 N9 U1 W5 Z0
  );
  assert.ok(tracks.cells.every((c) => c.maxReflectivity?.dbz >= 40));
});

test('mesocyclones: circulations matched to their table rows', () => {
  const md = decodeMesocyclones(NMD);
  assert.equal(md.product, 'NMD');
  assert.equal(md.scanMs, SCAN_MS);
  assert.deepEqual(md.averageMotion, { fromDeg: 32, speedKt: 18 });
  assert.deepEqual(
    md.circulations.map((c) => c.circulationId),
    ['372', '530', '734', '329', '123', '834', '741'],
  );
  const [first] = md.circulations;
  // Table: 254°/30 nm, rank 4L, storm Z0, low-level RV 26 / DV 50 kt.
  assert.ok(Math.abs(first.azimuthDeg - 254) < 1);
  assert.ok(Math.abs(first.rangeKm / NM - 30) < 1);
  assert.equal(first.strengthRank, '4L');
  assert.equal(first.stormId, 'Z0');
  assert.deepEqual(first.lowLevel, {
    rotationalVelocityKt: 26,
    deltaVelocityKt: 50,
    baseKft: { value: 2, qualifier: 'below' },
  });
  assert.deepEqual(first.depthKft, { value: 4, qualifier: 'above' });
  assert.equal(first.stormRelativeDepthPct, 41);
  assert.deepEqual(first.maxRotationalVelocity, { heightKft: 2, kt: 26 });
  assert.equal(first.tvs, false);
  assert.deepEqual(first.motion, { fromDeg: 90, speedKt: 12 });
  assert.equal(first.msi, 2866);
  // Moving from the east: forecast positions head west.
  assert.ok(first.forecast.at(-1).lon < first.lon);
  assert.equal(first.past.length, 3);
  // Circulations without a computed motion still decode.
  assert.equal(md.circulations[2].motion, null);
});

test('a quiet-day mesocyclone product decodes to no circulations', () => {
  const md = decodeMesocyclones(NMD_EMPTY);
  assert.deepEqual(md.circulations, []);
  assert.equal(md.averageMotion, null);
});

test('decoders refuse the wrong product', () => {
  assert.throws(() => decodeStormTracks(NMD), /expected product 58/);
  assert.throws(() => decodeMesocyclones(NST), /expected product 141/);
});

test('positions are placed along great circles from the radar', () => {
  const site = { lat: 35, lon: -97 };
  assert.deepEqual(destination(site, 0, 0), site);
  const north = destination(site, 0, 111.195);
  assert.ok(Math.abs(north.lat - 36) < 0.001);
  assert.ok(Math.abs(north.lon + 97) < 1e-9);
});

test('SAILS cuts are the returns to the lowest angle after climbing', () => {
  const sweeps = [0.5, 0.5, 0.9, 1.3, 0.5, 1.8, 2.4, 0.5, 3.1].map(
    (elevationDeg, k) => ({ elevationNumber: k + 1, elevationDeg }),
  );
  assert.deepEqual(
    [...supplementalCuts(sweeps)],
    [
      [5, 1],
      [8, 2],
    ],
  );
  // A VCP 212 volume without SAILS (split cuts at the bottom only).
  const plain = [0.5, 0.5, 0.9, 1.3, 1.8].map((elevationDeg, k) => ({
    elevationNumber: k + 1,
    elevationDeg,
  }));
  assert.equal(supplementalCuts(plain).size, 0);
});

test('the 0.9° and 1.8° intermediate tilts are served', () => {
  for (const code of [
    'NAB',
    'NBB',
    'NAG',
    'NAC',
    'NBC',
    'NAX',
    'NBX',
    'NAK',
    'NBK',
    'NAH',
    'NBH',
  ])
    assert.ok(LEVEL3_PRODUCTS.has(code), code);
  assert.equal(LEVEL3_PRODUCTS.has('NST'), false, 'detections are not images');
});

function mountAttributes() {
  const objects = {
    HGX_NST_2026_10_02_18_45_33: NST,
    HGX_NMD_2026_10_02_18_45_33: NMD,
  };
  const now = () => SCAN_MS + 120_000;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/') {
      const prefix = u.searchParams.get('prefix');
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix));
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join('')}</ListBucketResult>`,
      );
    }
    const body = objects[u.pathname.slice(1)];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  };
  const ingest = createLevel3Ingest({
    now,
    service: createLevel3Service({ fetchImpl, now }),
  });
  const registry = createProviderRegistry({ runtimeOptions: { now } });
  registry.register(ingest.provider);
  let handler;
  for (const plugin of registry.plugins())
    plugin.configureServer({
      middlewares: {
        use: (path, fn) => path === '/api/radar/l3' && (handler = fn),
      },
    });
  registry.health.stop();
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body });
        },
      };
      handler({ url }, res);
    });
  return { ingest, registry, call };
}

test('/attributes serves storm tracks and mesocyclones, with health per radar and product', async () => {
  const { ingest, registry, call } = mountAttributes();
  try {
    const tracks = JSON.parse(
      (await call('/attributes?site=HGX&product=NST')).body,
    );
    assert.equal(tracks.key, 'HGX_NST_2026_10_02_18_45_33');
    assert.equal(tracks.cells.length, 21);
    const md = JSON.parse(
      (await call('/attributes?site=hgx&product=nmd')).body,
    );
    assert.equal(md.circulations.length, 7);

    const health = registry.health
      .evaluate()
      .providers.find((p) => p.id === 'nexrad-level3');
    assert.deepEqual(
      health.products.map((p) => [p.product, p.state, p.dataAgeMs]),
      [
        ['HGX/NST', 'healthy', 120_000],
        ['HGX/NMD', 'healthy', 120_000],
      ],
    );
    assert.equal(registry.get('nexrad-level3').latest().data.count, 7);

    assert.equal((await call('/attributes?site=HGX&product=N0B')).status, 400);
    assert.equal((await call('/attributes?site=TLX&product=NST')).status, 404);
    assert.equal((await call('/scan?site=HGX&product=NST')).status, 400);
  } finally {
    ingest.close();
  }
});
