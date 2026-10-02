import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEXRAD_STALE_AFTER_MS,
  createNexradLayer,
  formatScanLabel,
  nexradScanStamp,
  nexradTileTemplate,
  parseNexradMeta,
} from './nexrad.js';

const VALID_ISO = '2026-10-02T00:10:00Z';
const VALID_MS = Date.parse(VALID_ISO);

test('scan stamp is the UTC YYYYMMDDHHMM product stamp', () => {
  assert.equal(nexradScanStamp(VALID_MS), '202610020010');
  assert.equal(nexradScanStamp(Date.parse('2026-01-05T09:03:00Z')), '202601050903');
  assert.equal(nexradScanStamp(NaN), null);
});

test('tile template pins a named scan, falling back to the rolling alias', () => {
  assert.equal(
    nexradTileTemplate('202610020010'),
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-202610020010/{z}/{x}/{y}.png',
  );
  for (const bad of [null, undefined, '', '2026', '../../etc']) {
    assert.match(nexradTileTemplate(bad), /\/nexrad-n0q-900913\/\{z\}\/\{x\}\/\{y\}\.png$/);
  }
});

test('metadata parser reads valid time and radar quorum, rejects malformed payloads', () => {
  assert.deepEqual(
    parseNexradMeta({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } }),
    { validMs: VALID_MS, stamp: '202610020010', radarsReporting: 143, radarsTotal: 147 },
  );
  assert.deepEqual(
    parseNexradMeta({ meta: { valid: VALID_ISO } }),
    { validMs: VALID_MS, stamp: '202610020010', radarsReporting: null, radarsTotal: null },
  );
  assert.equal(parseNexradMeta(null), null);
  assert.equal(parseNexradMeta({}), null);
  assert.equal(parseNexradMeta({ meta: { valid: 'not a date' } }), null);
});

test('scan label is HH:MMZ', () => {
  assert.equal(formatScanLabel(VALID_MS), 'scan 00:10Z');
  assert.equal(formatScanLabel(undefined), null);
});

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('update reports the scan and radar count; a metadata failure keeps the layer enabled', async () => {
  let clock = VALID_MS + 60_000;
  let next = fakeResponse({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } });
  // A viewer with no imagery surfaces: exercises the data path without Cesium rendering.
  const viewer = { scene: { primitives: { length: 0 } } };
  const layer = createNexradLayer({ fetchImpl: async () => next, now: () => clock });
  layer.init(viewer);
  layer.enable(viewer);

  assert.equal(await layer.update(viewer), true);
  let stats = layer.getStats();
  assert.equal(stats.count, 143);
  assert.equal(stats.error, null);
  assert.equal(stats.fallback, false);
  assert.equal(stats.stale, false);
  assert.equal(stats.loadingLabel, 'scan 00:10Z · 143/147 radars');

  clock = VALID_MS + NEXRAD_STALE_AFTER_MS + 1;
  next = fakeResponse(null, { ok: false, status: 503 });
  assert.equal(await layer.update(viewer), true);
  stats = layer.getStats();
  assert.equal(stats.error, 'IEM HTTP 503');
  assert.equal(stats.stale, true, 'an old scan reads stale, not current');
});

test('first-load metadata failure falls back to the latest composite instead of failing', async () => {
  const viewer = { scene: { primitives: { length: 0 } } };
  const layer = createNexradLayer({
    fetchImpl: async () => { throw new TypeError('network'); },
    now: () => VALID_MS,
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(stats.fallback, true);
  assert.equal(stats.error, null);
  assert.equal(stats.loadingLabel, 'latest composite · scan time unknown');
});

test('radar never drapes onto a 3D tileset, and says so when the globe is hidden', async () => {
  const added = [];
  const collection = { add: (l) => added.push(l), contains: () => false, remove() {} };
  const tilesetLayers = { add: () => assert.fail('must not drape onto the photoreal tileset') };
  const viewer = {
    imageryLayers: collection,
    scene: { globe: { show: false }, primitives: { length: 1, get: () => ({ imageryLayers: tilesetLayers }) } },
  };
  const layer = createNexradLayer({
    fetchImpl: async () => fakeResponse({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } }),
    now: () => VALID_MS,
  });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  assert.equal(added.length, 1, 'exactly one globe imagery layer');
  const stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.match(stats.loadingLabel, /globe map/);
  viewer.scene.globe.show = true;
  assert.equal(layer.getStats().loadingLabel, 'scan 00:10Z · 143/147 radars');
  layer.disable(viewer);
});

// ── Single-radar Level III products ─────────────────────────────────────────

import * as Cesium from 'cesium';
import { NEXRAD_PRODUCTS, nearestRadarSite, parseRadarSites, radarIcao } from './nexrad.js';

const SITES_GEOJSON = {
  features: [
    { id: 'TLX', properties: { sid: 'TLX', sname: 'Oklahoma City', state: 'OK', online: true }, geometry: { coordinates: [-97.28, 35.33] } },
    { id: 'ICT', properties: { sid: 'ICT', sname: 'Wichita', state: 'KS', online: true }, geometry: { coordinates: [-97.44, 37.65] } },
    { id: 'HKI', properties: { sid: 'HKI', sname: 'Kauai', state: 'HI', online: true }, geometry: { coordinates: [-159.55, 21.89] } },
    { id: 'OFF', properties: { sid: 'OFF', sname: 'Retired', state: 'TX', online: false }, geometry: { coordinates: [-97, 33] } },
  ],
};

test('radar sites parse, skip offline radars, and display as ICAO ids', () => {
  const sites = parseRadarSites(SITES_GEOJSON);
  assert.deepEqual(sites.map((s) => s.id), ['TLX', 'ICT', 'HKI']);
  assert.deepEqual(sites.map(radarIcao), ['KTLX', 'KICT', 'PHKI']);
});

test('the nearest radar wins, and nothing is chosen out of range', () => {
  const sites = parseRadarSites(SITES_GEOJSON);
  assert.equal(nearestRadarSite(sites, 35.5, -97.5).id, 'TLX');
  assert.equal(nearestRadarSite(sites, 37.2, -97.3).id, 'ICT');
  assert.equal(nearestRadarSite(sites, 30, -40), null, 'mid-Atlantic has no radar');
});

test('every product maps to the Level III codes NOAA publishes, lowest tilt first', () => {
  assert.deepEqual(NEXRAD_PRODUCTS.ref.codes, ['N0B', 'N1B', 'N2B', 'N3B']);
  assert.deepEqual(NEXRAD_PRODUCTS.vel.codes, ['N0G', 'N1G']);
  assert.deepEqual(NEXRAD_PRODUCTS.cc.codes, ['N0C', 'N1C', 'N2C', 'N3C']);
  assert.deepEqual(NEXRAD_PRODUCTS.vil.codes, ['DVL']);
  assert.equal(NEXRAD_PRODUCTS.composite.codes, undefined);
});

const BOUNDS = { west: -100.6, south: 32.6, east: -94, north: 38 };

function scanPayload(code, { elevationDeg = 0.5 } = {}) {
  return {
    key: `TLX_${code}_2026_10_02_00_05_00`,
    product: code,
    scanMs: Date.parse('2026-10-02T00:05:00Z'),
    elevationDeg,
    bounds: BOUNDS,
    image: `/api/radar/l3/image/TLX_${code}_2026_10_02_00_05_00.png`,
  };
}

function siteLayer({ center = { lat: 35.5, lon: -97.5 }, scan = (code) => fakeResponse(scanPayload(code)) } = {}) {
  const urls = [];
  const added = [];
  const removed = [];
  const provided = [];
  const layer = createNexradLayer({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('NEXRAD.geojson')) return fakeResponse(SITES_GEOJSON);
      const l3 = /\/api\/radar\/l3\/scan\?site=TLX&product=([A-Z0-9]{3})/.exec(url);
      if (l3) return scan(l3[1]);
      return fakeResponse({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } });
    },
    now: () => VALID_MS,
    locate: () => center,
    // A real provider object (never fetched in Node) so ImageryLayer accepts it.
    makeProvider: async (spec) => { provided.push(spec); return new Cesium.UrlTemplateImageryProvider({ url: 'x/{z}/{x}/{y}' }); },
  });
  const viewer = {
    imageryLayers: { add: (l) => added.push(l), contains: (l) => added.includes(l) && !removed.includes(l), remove: (l) => removed.push(l) },
    scene: { globe: { show: true }, primitives: { length: 0 } },
  };
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, urls, added, removed, provided };
}

test('VEL asks the app server for the nearest radar and shows its decoded image', async () => {
  const { layer, viewer, urls, provided } = siteLayer();
  assert.equal(layer.setParams({ product: 'vel' }), true);
  await layer.update(viewer);
  assert.ok(urls.includes('/api/radar/l3/scan?site=TLX&product=N0G'));
  assert.equal(provided.at(-1).image, '/api/radar/l3/image/TLX_N0G_2026_10_02_00_05_00.png');
  assert.deepEqual(provided.at(-1).bounds, BOUNDS);
  assert.equal(layer.getStats().loadingLabel, 'KTLX VEL 0.5° · scan 00:05Z · Oklahoma City');
  layer.disable(viewer);
});

test('the TILT chip steps through elevations and wraps', async () => {
  const { layer, viewer, urls } = siteLayer();
  layer.setParams({ product: 'cc' });
  await layer.update(viewer);
  let tilt = layer.getRowControls().chips.find((c) => c.id === 'tilt');
  assert.equal(tilt.label, 'TILT 1/4 0.5°');
  assert.deepEqual(tilt.params, { tilt: 1 });
  layer.setParams(tilt.params);
  await layer.update(viewer);
  assert.ok(urls.includes('/api/radar/l3/scan?site=TLX&product=N1C'));
  layer.setParams({ tilt: 3 });
  tilt = layer.getRowControls().chips.find((c) => c.id === 'tilt');
  assert.deepEqual(tilt.params, { tilt: 0 }, 'wraps back to the lowest tilt');
  layer.setParams({ product: 'srv' });
  assert.equal(layer.getRowControls().chips.find((c) => c.id === 'tilt'), undefined, 'single-tilt products have no TILT chip');
  assert.equal(layer.getParams().tilt, 0, 'a new product starts at the lowest tilt');
  layer.disable(viewer);
});

test('switching product replaces the image at once; a new scan of the same product crossfades', async () => {
  const { layer, viewer, added, removed } = siteLayer();
  layer.setParams({ product: 'ref' });
  await layer.update(viewer);
  layer.setParams({ product: 'vel' });
  await layer.update(viewer);
  assert.equal(added.length, 2);
  assert.deepEqual(removed, [added[0]], 'REF removed the moment VEL arrived');
  layer.disable(viewer);
});

test('an unavailable product clears the old image and says why', async () => {
  const { layer, viewer, added, removed } = siteLayer({
    scan: (code) => (code === 'N0K'
      ? fakeResponse({ error: 'N0K is not available from this radar right now' }, { ok: false, status: 404 })
      : fakeResponse(scanPayload(code))),
  });
  layer.setParams({ product: 'ref' });
  await layer.update(viewer);
  layer.setParams({ product: 'kdp' });
  await layer.update(viewer);
  assert.deepEqual(removed, [added[0]]);
  assert.match(layer.getStats().error, /not available/);
  layer.disable(viewer);
});

test('no radar near the view is a calm guidance state, and bad params are refused', async () => {
  const { layer, viewer, added } = siteLayer({ center: { lat: 30, lon: -40 } });
  layer.setParams({ product: 'ref' });
  await layer.update(viewer);
  assert.equal(added.length, 0);
  assert.equal(layer.getStats().status, 'idle');
  assert.match(layer.getStats().loadingLabel, /no radar near/);
  assert.equal(layer.setParams({ product: 'N0Q' }), false);
  assert.equal(layer.setParams({ tilt: 7 }), false);
  layer.disable(viewer);
});

test('the legend follows the product and hides when no radar is on screen', async () => {
  const calls = [];
  const legend = { show: (m) => calls.push(['show', m.title, m.subtitle]), hide: () => calls.push(['hide']), destroy() {} };
  const viewer = {
    imageryLayers: { add() {}, contains: () => true, remove() {} },
    scene: { globe: { show: true }, primitives: { length: 0 } },
  };
  let center = { lat: 35.5, lon: -97.5 };
  const layer = createNexradLayer({
    fetchImpl: async (url) => (url.includes('NEXRAD.geojson') ? fakeResponse(SITES_GEOJSON)
      : url.includes('/api/radar/l3/') ? fakeResponse(scanPayload('N0C', { elevationDeg: 0.9 }))
        : fakeResponse({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } })),
    now: () => VALID_MS,
    locate: () => center,
    makeProvider: async () => new Cesium.UrlTemplateImageryProvider({ url: 'x/{z}/{x}/{y}' }),
    legend,
  });
  layer.init(viewer);
  layer.enable(viewer);
  layer.setParams({ product: 'cc' });
  await layer.update(viewer);
  assert.deepEqual(calls.at(-1), ['show', 'Correlation coefficient', '0.9° tilt']);
  center = { lat: 30, lon: -40 };
  await layer.update(viewer);
  assert.deepEqual(calls.at(-1), ['hide'], 'no radar nearby → no legend');
  center = { lat: 35.5, lon: -97.5 };
  viewer.scene.globe.show = false;
  await layer.update(viewer);
  assert.deepEqual(calls.at(-1), ['hide'], 'photoreal map hides the radar, and its legend');
  layer.disable(viewer);
  assert.deepEqual(calls.at(-1), ['hide']);
});

test('the cursor readout only answers for a single-radar scan that is on screen', async () => {
  const { layer, viewer } = siteLayer();
  assert.equal(layer.readoutTarget(), null, 'composite has no values');
  layer.setParams({ product: 'vel' });
  await layer.update(viewer);
  assert.deepEqual(layer.readoutTarget(), { key: 'TLX_N0G_2026_10_02_00_05_00', group: 'vel' });
  viewer.scene.globe.show = false;
  assert.equal(layer.readoutTarget(), null, 'radar hidden by the photoreal map');
  viewer.scene.globe.show = true;
  layer.disable(viewer);
  assert.equal(layer.readoutTarget(), null);
});
