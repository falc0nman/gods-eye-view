import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { NEXRAD_PRODUCTS, createNexradLayer } from './index.js';
import { nearestRadarSite, parseRadarSites, radarIcao, validateScan } from './source.js';

const NOW = Date.parse('2026-10-02T00:10:00Z');
const SITES_GEOJSON = {
  features: [
    { id: 'TLX', properties: { sid: 'TLX', sname: 'Oklahoma City', state: 'OK', online: true }, geometry: { coordinates: [-97.28, 35.33] } },
    { id: 'ICT', properties: { sid: 'ICT', sname: 'Wichita', state: 'KS', online: true }, geometry: { coordinates: [-97.44, 37.65] } },
    { id: 'HKI', properties: { sid: 'HKI', sname: 'Kauai', state: 'HI', online: true }, geometry: { coordinates: [-159.55, 21.89] } },
    { id: 'OFF', properties: { sid: 'OFF', sname: 'Retired', state: 'TX', online: false }, geometry: { coordinates: [-97, 33] } },
  ],
};
const SITES = parseRadarSites(SITES_GEOJSON);
const BOUNDS = { west: -100.6, south: 32.6, east: -94, north: 38 };

function scanFor(code, { elevationDeg = 0.5 } = {}) {
  const key = `TLX_${code}_2026_10_02_00_05_00`;
  return validateScan({
    key,
    image: `/api/radar/l3/image/${key}.png`,
    bounds: BOUNDS,
    scanMs: Date.parse('2026-10-02T00:05:00Z'),
    elevationDeg,
  });
}

function radarLayer({
  center = { lat: 35.5, lon: -97.5 },
  getScan = async (site, code) => scanFor(code),
  legend,
} = {}) {
  const scans = [];
  const added = [];
  const removed = [];
  const provided = [];
  const layer = createNexradLayer({
    source: {
      getSites: async () => SITES,
      getScan: async (site, code, options) => {
        scans.push(`${site}/${code}`);
        return getScan(site, code, options);
      },
      getValue: async () => ({}),
    },
    now: () => NOW,
    locate: () => center,
    // A real provider object (never fetched in Node) so ImageryLayer accepts it.
    makeProvider: async (spec) => {
      provided.push(spec);
      return new Cesium.UrlTemplateImageryProvider({ url: 'x/{z}/{x}/{y}' });
    },
    ...(legend ? { legend } : {}),
  });
  const viewer = {
    imageryLayers: {
      add: (l) => added.push(l),
      contains: (l) => added.includes(l) && !removed.includes(l),
      remove: (l) => removed.push(l),
    },
    scene: { globe: { show: true }, primitives: { length: 0 } },
  };
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, scans, added, removed, provided };
}

test('radar sites parse, skip offline radars, and display as ICAO ids', () => {
  assert.deepEqual(SITES.map((s) => s.id), ['TLX', 'ICT', 'HKI']);
  assert.deepEqual(SITES.map(radarIcao), ['KTLX', 'KICT', 'PHKI']);
});

test('the nearest radar wins, and nothing is chosen out of range', () => {
  assert.equal(nearestRadarSite(SITES, 35.5, -97.5).id, 'TLX');
  assert.equal(nearestRadarSite(SITES, 37.2, -97.3).id, 'ICT');
  assert.equal(nearestRadarSite(SITES, 30, -40), null, 'mid-Atlantic has no radar');
});

test('scan metadata is validated before it becomes an imagery request', () => {
  assert.equal(scanFor('N0G').key, 'TLX_N0G_2026_10_02_00_05_00');
  assert.throws(() => validateScan({ ...scanFor('N0G'), image: 'https://evil.example/x.png' }), /Malformed/);
  assert.throws(() => validateScan({ ...scanFor('N0G'), bounds: { west: 1, south: 0, east: 0, north: 1 } }), /Malformed/);
});

test('every product maps to the Level III codes NOAA publishes, lowest tilt first', () => {
  assert.deepEqual(NEXRAD_PRODUCTS.ref.codes, ['N0B', 'N1B', 'N2B', 'N3B']);
  assert.deepEqual(NEXRAD_PRODUCTS.vel.codes, ['N0G', 'N1G']);
  assert.deepEqual(NEXRAD_PRODUCTS.cc.codes, ['N0C', 'N1C', 'N2C', 'N3C']);
  assert.deepEqual(NEXRAD_PRODUCTS.vil.codes, ['DVL']);
  assert.equal(NEXRAD_PRODUCTS.composite, undefined, 'the national mosaic is the Weather Radar layer');
});

test('REF is the default; VEL asks for the nearest radar and shows its decoded image', async () => {
  const { layer, viewer, scans, provided } = radarLayer();
  await layer.update(viewer);
  assert.deepEqual(scans, ['TLX/N0B']);
  assert.equal(layer.setParams({ product: 'vel' }), true);
  await layer.update(viewer);
  assert.equal(scans.at(-1), 'TLX/N0G');
  assert.equal(provided.at(-1).image, '/api/radar/l3/image/TLX_N0G_2026_10_02_00_05_00.png');
  assert.deepEqual(provided.at(-1).bounds, BOUNDS);
  assert.equal(layer.getStats().loadingLabel, 'KTLX VEL 0.5° · scan 00:05Z · Oklahoma City');
  layer.disable(viewer);
});

test('the TILT chip steps through elevations and wraps', async () => {
  const { layer, viewer, scans } = radarLayer();
  layer.setParams({ product: 'cc' });
  await layer.update(viewer);
  let tilt = layer.getRowControls().chips.find((c) => c.id === 'tilt');
  assert.equal(tilt.label, 'TILT 1/4 0.5°');
  assert.deepEqual(tilt.params, { tilt: 1 });
  layer.setParams(tilt.params);
  await layer.update(viewer);
  assert.equal(scans.at(-1), 'TLX/N1C');
  layer.setParams({ tilt: 3 });
  tilt = layer.getRowControls().chips.find((c) => c.id === 'tilt');
  assert.deepEqual(tilt.params, { tilt: 0 }, 'wraps back to the lowest tilt');
  layer.setParams({ product: 'srv' });
  assert.equal(layer.getRowControls().chips.find((c) => c.id === 'tilt'), undefined);
  assert.equal(layer.getParams().tilt, 0, 'a new product starts at the lowest tilt');
  layer.disable(viewer);
});

test('switching product replaces the image at once', async () => {
  const { layer, viewer, added, removed } = radarLayer();
  await layer.update(viewer);
  layer.setParams({ product: 'vel' });
  await layer.update(viewer);
  assert.equal(added.length, 2);
  assert.deepEqual(removed, [added[0]], 'REF removed the moment VEL arrived');
  layer.disable(viewer);
});

test('an unavailable product clears the old image and says why', async () => {
  const { layer, viewer, added, removed } = radarLayer({
    getScan: async (site, code) => {
      if (code === 'N0K') throw new Error('N0K is not available from this radar right now');
      return scanFor(code);
    },
  });
  await layer.update(viewer);
  layer.setParams({ product: 'kdp' });
  await layer.update(viewer);
  assert.deepEqual(removed, [added[0]]);
  assert.match(layer.getStats().error, /not available/);
  layer.disable(viewer);
});

test('no radar near the view is a calm guidance state, and bad params are refused', async () => {
  const { layer, viewer, added } = radarLayer({ center: { lat: 30, lon: -40 } });
  await layer.update(viewer);
  assert.equal(added.length, 0);
  assert.equal(layer.getStats().status, 'idle');
  assert.match(layer.getStats().loadingLabel, /no radar near/);
  assert.equal(layer.setParams({ product: 'composite' }), false);
  assert.equal(layer.setParams({ tilt: 7 }), false);
  layer.disable(viewer);
});

test('the legend follows the product and hides when no radar is on screen', async () => {
  const calls = [];
  const legend = {
    show: (m) => calls.push(['show', m.title, m.subtitle]),
    hide: () => calls.push(['hide']),
    destroy() {},
  };
  const { layer, viewer } = radarLayer({ legend, getScan: async (s, code) => scanFor(code, { elevationDeg: 0.9 }) });
  layer.setParams({ product: 'cc' });
  await layer.update(viewer);
  assert.deepEqual(calls.at(-1), ['show', 'Correlation coefficient', '0.9° tilt']);
  viewer.scene.globe.show = false;
  await layer.update(viewer);
  assert.deepEqual(calls.at(-1), ['hide'], 'photoreal map hides the radar, and its legend');
  layer.disable(viewer);
  assert.deepEqual(calls.at(-1), ['hide']);
});

test('the cursor readout only answers for a scan that is on screen', async () => {
  const { layer, viewer } = radarLayer();
  assert.equal(layer.readoutTarget(), null, 'nothing loaded yet');
  layer.setParams({ product: 'vel' });
  await layer.update(viewer);
  assert.deepEqual(layer.readoutTarget(), { key: 'TLX_N0G_2026_10_02_00_05_00', group: 'vel' });
  viewer.scene.globe.show = false;
  assert.equal(layer.readoutTarget(), null, 'radar hidden by the photoreal map');
  viewer.scene.globe.show = true;
  layer.disable(viewer);
  assert.equal(layer.readoutTarget(), null);
});

test('a layer without a radar source is a construction error', () => {
  assert.throws(() => createNexradLayer({}), /radar source/);
});
