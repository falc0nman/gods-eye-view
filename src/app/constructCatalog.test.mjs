import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';

test('catalogs construct distinct layers from their supplied source', async (t) => {
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
  });
  const first = createApplicationCatalog({
    sources: createStandaloneLayerSources(),
    signal: a.signal,
    surface: fixtureSurface(a.signal),
  });
  const second = createApplicationCatalog({
    sources: createStandaloneLayerSources(),
    signal: b.signal,
    surface: fixtureSurface(b.signal),
  });
  assert.equal(first.layers.length, 13);
  for (const id of ['nexrad', 'nws-warnings', 'team-chasers'])
    assert.ok(first.get(id), `${id} (storm chase) is registered`);
  assert.equal(first.get('local-adsb'), undefined, 'GW-57 removed Local ADS-B');
  assert.notEqual(first.weatherClock, second.weatherClock);
  await first.weatherClock.setTarget('2026-09-21T12:00:00.000Z');
  assert.match(
    first.get('wind').getRowControls().info,
    /Forecast · does not follow history/,
  );
  assert.equal(second.get('wind').getRowControls().summary.status, null);
  for (const id of ['weather-radar', 'weather-satellite', 'weather-lightning'])
    assert.equal(
      first.get(id).getDiagnostics().clock.target,
      '2026-09-21T12:00:00.000Z',
    );
  const order = first.layers.map(({ id }) => id);
  assert.deepEqual(
    order.slice(order.indexOf('traffic'), order.indexOf('directions') + 1),
    ['traffic', 'cctv', 'radio', 'directions'],
  );
  // GW-53: the Bhote Koshi event pack is removed.
  assert.equal(first.get('bhote-koshi-2026'), undefined);
  assert.equal(first.get('bhote-koshi-locator'), undefined);
  // GW-57: submarine cables, ALPR, earthquakes, fires, bikeshare, transit, data centers, dams and launches are removed.
  assert.equal(first.get('telegeography-submarine-cables'), undefined);
  assert.equal(first.get('alpr-cameras'), undefined);
  assert.equal(first.get('earthquakes'), undefined);
  assert.equal(first.get('local-firms'), undefined);
  assert.equal(first.get('fire-perimeters'), undefined);
  assert.equal(first.get('bikeshare'), undefined);
  assert.equal(first.get('transit'), undefined);
  assert.equal(first.get('local-datacenters'), undefined);
  assert.equal(first.get('local-dams'), undefined);
  assert.equal(first.get('rocket-launches'), undefined);
  // GW-57: civilian and military flights are removed.
  assert.equal(first.get('flights'), undefined);
  assert.equal(first.get('military'), undefined);
  const lifecycle = new LayerLifecycle({});
  for (const layer of first.layers) lifecycle.register(layer);
  const rows = lifecycle.getAll();
  assert.equal(
    rows.find((row) => row.id === 'traffic')?.showInTogglePanel,
    true,
    'ordinary data layer entries remain visible',
  );
  assert.deepEqual(
    first.layers.map(({ id }) => id),
    second.layers.map(({ id }) => id),
  );
  for (const layer of first.layers)
    assert.notEqual(layer, second.get(layer.id));
  assert.equal(
    catalogControlServices(first).trafficLayer,
    first.get('traffic'),
  );
  a.abort();
  assert.equal(
    await first.weatherClock.setTarget('2026-09-21T13:00:00.000Z'),
    false,
  );
});

test('invalid or already cancelled construction fails', () => {
  const lifetime = new AbortController();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: {},
        signal: lifetime.signal,
        surface: fixtureSurface(lifetime.signal),
      }),
    /catalog source/,
  );
  lifetime.abort();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: createStandaloneLayerSources(),
        signal: lifetime.signal,
      }),
    { name: 'AbortError' },
  );
});

function fixtureSurface(signal) {
  return createSurfaceServices({
    terrainSource: { getHeights: async () => [] },
    signal,
    eventTarget: null,
  });
}
