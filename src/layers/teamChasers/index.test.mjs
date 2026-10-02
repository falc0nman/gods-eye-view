import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaserAgeColor, chaserDetail, createTeamChasersLayer } from './index.js';
import { createTeamChasersSource, normalizeChasers } from './source.js';

const NOW = Date.parse('2026-10-02T01:00:00Z');
const noopOverlay = { setEntries() {}, setVisible() {}, clearSource() {} };
const viewer = { dataSources: { add() {}, remove() {} } };

function layerWith(payload, status = 200) {
  const source = createTeamChasersSource({
    fetchImpl: async () => new Response(JSON.stringify(payload), { status }),
  });
  const layer = createTeamChasersLayer({ source, overlayHost: noopOverlay, now: () => NOW });
  layer.init(viewer);
  return layer;
}

test('age colors and detail line follow the placefile convention', () => {
  assert.equal(chaserAgeColor(60), '#00dc00');
  assert.equal(chaserAgeColor(300), '#ffbe00');
  assert.equal(chaserAgeColor(null), '#c83c3c');
  assert.equal(chaserDetail({ fixMs: NOW - 45_000, battery: 80 }, NOW), 'fix 45s ago · batt 80%');
  assert.equal(chaserDetail({ fixMs: null, battery: null }, NOW), 'fix unknown');
});

test('malformed chasers are dropped', () => {
  assert.deepEqual(normalizeChasers({ chasers: [{ id: 'a', name: 'Dana', lat: 35, lon: -97 }, { name: 'bad', lat: 'x' }, { lat: 95, lon: 0 }] })
    .map((c) => c.name), ['Dana']);
});

test('without a Life360 token the layer turns on and says how to set it up', async () => {
  const layer = layerWith({ configured: false, chasers: [] });
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.match(stats.loadingLabel, /LIFE360_TOKEN/);
});

test('a dead token surfaces as an error, not an endless "connecting"', async () => {
  const layer = layerWith({ configured: true, health: { state: 'INIT', detail: 'no circles available yet (token or throttle issue)' }, chasers: [] });
  await layer.update(viewer);
  assert.match(layer.getStats().error, /token or throttle/);
  const healthy = layerWith({ configured: true, health: { state: 'OK', detail: '1 chasers' }, chasers: [{ id: 'a', name: 'Dana', lat: 35, lon: -97, fixMs: NOW }] });
  await healthy.update(viewer);
  assert.equal(healthy.getStats().count, 1);
  assert.equal(healthy.getStats().loadingLabel, '1 on map · Life360 OK');
});

test('PICK CHASERS appears only once Life360 is set up, and opening it is not saved layer state', async () => {
  const unset = layerWith({ configured: false, chasers: [] });
  await unset.update(viewer);
  assert.equal(unset.getRowControls(), null);
  const ready = layerWith({ configured: true, health: { state: 'OK', detail: '0 chasers' }, chasers: [] });
  await ready.update(viewer);
  assert.deepEqual(ready.getRowControls().chips.map((c) => [c.id, c.params]), [['pick', { openPicker: true }]]);
  assert.deepEqual(ready.getParams(), {});
});

test('the layer refuses to build without a source or overlay host', () => {
  assert.throws(() => createTeamChasersLayer({ overlayHost: noopOverlay }), /snapshot source/);
  assert.throws(() => createTeamChasersLayer({ source: { getSnapshot() {} } }), /overlay host/);
});
