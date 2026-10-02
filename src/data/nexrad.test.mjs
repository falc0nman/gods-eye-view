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

// ── Single-radar products ───────────────────────────────────────────────────

import { nearestRadarSite, parseRadarSites, radarIcao, siteTileTemplate } from './nexrad.js';

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

test('single-radar tiles pin a scan or fall back to latest; ids are validated', () => {
  assert.match(siteTileTemplate('TLX', 'N0B', '202610020105'), /ridge::TLX-N0B-202610020105\/\{z\}/);
  assert.match(siteTileTemplate('TLX', 'N0S', null), /ridge::TLX-N0S-0\/\{z\}/);
  assert.throws(() => siteTileTemplate('../x', 'N0B', null));
});

function siteLayer({ center = { lat: 35.5, lon: -97.5 }, siteMeta = { meta: { valid: '2026-10-02T00:05:00Z' } } } = {}) {
  const urls = [];
  const added = [];
  const layer = createNexradLayer({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('NEXRAD.geojson')) return fakeResponse(SITES_GEOJSON);
      if (url.includes('/ridge/')) return siteMeta ? fakeResponse(siteMeta) : fakeResponse(null, { ok: false, status: 404 });
      return fakeResponse({ meta: { valid: VALID_ISO, radar_quorum: '143/147' } });
    },
    now: () => VALID_MS,
    locate: () => center,
  });
  const viewer = {
    imageryLayers: { add: (l) => added.push(l), contains: () => true, remove() {} },
    scene: { globe: { show: true }, primitives: { length: 0 } },
  };
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, urls, added };
}

test('REFLECTIVITY follows the nearest radar and reports it by ICAO and scan time', async () => {
  const { layer, viewer, urls, added } = siteLayer();
  assert.equal(layer.setParams({ product: 'ref' }), true);
  await layer.update(viewer);
  assert.ok(urls.some((u) => u.endsWith('/ridge/TLX/N0B_0.json')));
  assert.equal(added.length, 1);
  assert.equal(layer.getStats().loadingLabel, 'KTLX REF · scan 00:05Z · Oklahoma City');
  assert.deepEqual(layer.getRowControls().chips.filter((c) => c.active).map((c) => c.id), ['ref']);
  layer.disable(viewer);
});

test('SRV with no scan metadata falls back to the latest tiles and says so', async () => {
  const { layer, viewer } = siteLayer({ siteMeta: null });
  layer.setParams({ product: 'srv' });
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.fallback, true);
  assert.equal(stats.loadingLabel, 'KTLX SRV · latest scan · Oklahoma City');
  layer.disable(viewer);
});

test('no radar near the view is a calm guidance state, and unknown products are refused', async () => {
  const { layer, viewer, added } = siteLayer({ center: { lat: 30, lon: -40 } });
  layer.setParams({ product: 'ref' });
  await layer.update(viewer);
  assert.equal(added.length, 0);
  assert.equal(layer.getStats().status, 'idle');
  assert.match(layer.getStats().loadingLabel, /no radar near/);
  assert.equal(layer.setParams({ product: 'N0Q' }), false);
  layer.disable(viewer);
});
