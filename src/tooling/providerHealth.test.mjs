import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineProvider } from '../../server/providers/common/provider.js';
import {
  createHealthMonitor,
  evaluateProviderHealth,
  resolveThresholds,
} from '../../server/providers/common/health.js';
import { createProviderRegistry } from '../../server/providers/registry.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-02T21:00:00Z');

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** A push provider whose items are handed in by the test. */
function pushProvider(overrides = {}) {
  let emit = null;
  const definition = defineProvider({
    id: 'radar-test',
    mode: 'push',
    source: { name: 'Test' },
    subscribe: (_ctx, push) => {
      emit = push;
      return () => (emit = null);
    },
    fetch: (item) => {
      if (item.fail) throw new Error('upstream 503');
      return item;
    },
    normalize: (item) => ({
      validTime: item.validTime,
      product: item.site,
      data: null,
      provenance: { availableAt: item.availableAt },
    }),
    health: { degradedAfterMs: 2 * MIN, staleAfterMs: 5 * MIN },
    ...overrides,
  });
  return { definition, emit: (item) => emit(item) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides, registryOptions = {}) {
  const c = clock();
  const registry = createProviderRegistry({
    runtimeOptions: { now: c.now, onError: () => {} },
    ...registryOptions,
  });
  const p = pushProvider(overrides);
  const runtime = registry.register(p.definition);
  return { c, registry, runtime, emit: p.emit };
}

const healthOf = (registry, id = 'radar-test') =>
  registry.health.evaluate().providers.find((p) => p.id === id);

test('thresholds resolve product → provider override → definition', () => {
  const { definition } = pushProvider();
  assert.deepEqual(resolveThresholds(definition, null), {
    downAfterFailures: 3,
    degradedAfterMs: 2 * MIN,
    staleAfterMs: 5 * MIN,
  });
  const overrides = {
    'radar-test': { staleAfterMs: 10 * MIN },
    'radar-test:KTLX': { staleAfterMs: 1 * MIN, degradedAfterMs: 30_000 },
  };
  assert.equal(
    resolveThresholds(definition, 'KEAX', overrides).staleAfterMs,
    10 * MIN,
  );
  assert.deepEqual(
    [
      resolveThresholds(definition, 'KTLX', overrides).staleAfterMs,
      resolveThresholds(definition, 'KTLX', overrides).degradedAfterMs,
    ],
    [1 * MIN, 30_000],
  );
  // Without a degraded threshold, half the stale one.
  const bare = defineProvider({
    id: 'bare',
    mode: 'push',
    source: { name: 'x' },
    subscribe: () => () => {},
    normalize: () => null,
    health: { staleAfterMs: 4 * MIN },
  });
  assert.equal(resolveThresholds(bare, null).degradedAfterMs, 2 * MIN);
  assert.throws(
    () => pushProvider({ health: { staleAfterMs: -1 } }),
    /positive number/,
  );
});

test('an unused provider is idle, then healthy, degraded and stale as its data ages', async () => {
  const { c, registry, runtime, emit } = setup();
  assert.equal(healthOf(registry).state, 'idle');
  runtime.acquire();
  assert.equal(healthOf(registry).state, 'healthy');
  assert.equal(healthOf(registry).reason, 'waiting for first record');

  emit({
    key: 'a',
    site: 'KTLX',
    validTime: c.now() - 5_000,
    availableAt: c.now() - 1_200,
  });
  await settle();
  let h = healthOf(registry);
  assert.equal(h.state, 'healthy');
  assert.equal(h.products[0].product, 'KTLX');
  assert.equal(h.products[0].dataAgeMs, 5_000);
  // Ingest latency is reported separately from data age.
  assert.equal(h.products[0].availableToIngestMs.last, 1_200);

  c.advance(3 * MIN);
  h = healthOf(registry);
  assert.equal(h.state, 'degraded');
  assert.match(h.products[0].reason, /data 185 s old/);

  c.advance(3 * MIN);
  assert.equal(healthOf(registry).state, 'stale');
});

test('data age follows the newest valid time, not the latest arrival', async () => {
  const { c, registry, runtime, emit } = setup();
  runtime.acquire();
  emit({ key: 'new', site: 'KTLX', validTime: c.now() - 10_000 });
  emit({ key: 'late', site: 'KTLX', validTime: c.now() - 20 * MIN }); // backfilled
  await settle();
  assert.equal(healthOf(registry).products[0].dataAgeMs, 10_000);
  assert.equal(healthOf(registry).state, 'healthy');
});

test('failures degrade, repeated failures take the provider down, and a publish recovers it', async () => {
  const { c, registry, runtime, emit } = setup();
  runtime.acquire();
  emit({ key: 'f1', fail: true });
  await settle();
  assert.equal(healthOf(registry).state, 'degraded');
  assert.match(healthOf(registry).reason, /last fetch failed: upstream 503/);
  emit({ key: 'f2', fail: true });
  emit({ key: 'f3', fail: true });
  await settle();
  assert.equal(healthOf(registry).state, 'down');
  assert.match(healthOf(registry).reason, /3 failures in a row/);
  emit({ key: 'ok', site: 'KTLX', validTime: c.now() });
  await settle();
  assert.equal(healthOf(registry).state, 'healthy');
});

test('a provider with no data long after starting is down', () => {
  const { c, registry, runtime } = setup();
  runtime.acquire();
  c.advance(6 * MIN);
  assert.equal(healthOf(registry).state, 'down');
  assert.equal(healthOf(registry).reason, 'no data since start');
});

test('provider checks can degrade one product or the whole provider', async () => {
  let signals = [];
  const { c, registry, runtime, emit } = setup({
    health: { staleAfterMs: 5 * MIN, check: () => signals },
  });
  runtime.acquire();
  emit({ key: 'a', site: 'KTLX', validTime: c.now() });
  emit({ key: 'b', site: 'KEAX', validTime: c.now() });
  await settle();
  signals = [
    { product: 'KEAX', state: 'degraded', reason: 'feed unavailable' },
  ];
  const h = healthOf(registry);
  assert.deepEqual(
    h.products.map((p) => [p.product, p.state]),
    [
      ['KTLX', 'healthy'],
      ['KEAX', 'degraded'],
    ],
  );
  assert.equal(h.state, 'degraded');
  // A throwing check degrades rather than breaking the report.
  const throwing = evaluateProviderHealth(
    pushProvider({
      health: {
        check: () => {
          throw new Error('boom');
        },
      },
    }).definition,
    runtime.status(),
    { now: c.now },
  );
  assert.equal(throwing.state, 'degraded');
  assert.match(throwing.reason, /health check failed: boom/);
});

test('thresholds are configurable per product through the registry', async () => {
  const { c, registry, runtime, emit } = setup(undefined, {
    healthThresholds: { 'radar-test:KTLX': { staleAfterMs: 30_000 } },
  });
  runtime.acquire();
  emit({ key: 'a', site: 'KTLX', validTime: c.now() });
  emit({ key: 'b', site: 'KEAX', validTime: c.now() });
  await settle();
  c.advance(45_000);
  assert.deepEqual(
    healthOf(registry).products.map((p) => [
      p.product,
      p.state,
      p.staleAfterMs,
    ]),
    [
      ['KTLX', 'stale', 30_000],
      ['KEAX', 'healthy', 5 * MIN],
    ],
  );
});

test('transitions are kept briefly and pushed to subscribers', async () => {
  const c = clock();
  let status = {
    running: true,
    startedAt: T0,
    consecutiveFailures: 0,
    lastError: null,
    lastIngestAt: null,
    availableToIngestMs: {},
    products: [
      { product: 'KTLX', newestValidTime: T0, availableToIngestMs: {} },
    ],
  };
  const { definition } = pushProvider();
  const monitor = createHealthMonitor({
    entries: () => [
      { provider: definition, runtime: { status: () => status } },
    ],
    now: c.now,
    historyMs: 10 * MIN,
  });
  const seen = [];
  monitor.subscribe((_snapshot, changes) => seen.push(...changes));
  monitor.evaluate(); // baseline: no change recorded
  assert.deepEqual(monitor.history(), []);
  c.advance(6 * MIN);
  monitor.evaluate();
  assert.deepEqual(
    monitor.history().map((h) => [h.provider, h.product, h.from, h.to]),
    [
      ['radar-test', null, 'healthy', 'stale'],
      ['radar-test', 'KTLX', 'healthy', 'stale'],
    ],
  );
  assert.equal(seen.length, 2);
  status = { ...status, running: false };
  c.advance(11 * MIN);
  monitor.evaluate();
  // The stale transitions aged out; only the move to idle remains.
  assert.deepEqual(
    monitor.history().map((h) => [h.product, h.to]),
    [
      [null, 'idle'],
      ['KTLX', 'idle'],
    ],
  );
});

test('GET /api/providers/health reports every entry, legacy ones as unmonitored', async () => {
  const { c, registry, runtime, emit } = setup();
  registry.registerLegacy('legacy-one', () => ({ name: 'legacy-one' }));
  runtime.acquire();
  emit({ key: 'a', site: 'KTLX', validTime: c.now() });
  await settle();
  const routes = new Map();
  registry.plugins()[0].configureServer({
    middlewares: { use: (path, fn) => routes.set(path, fn) },
  });
  const get = (url) =>
    new Promise((resolve, reject) =>
      routes.get('/api/providers')(
        { method: 'GET', url },
        { writeHead() {}, end: (body) => resolve(JSON.parse(body)) },
        () => reject(new Error('not handled')),
      ),
    );
  try {
    const health = await get('/health');
    assert.deepEqual(
      health.providers.map((p) => [p.id, p.state]),
      [
        ['radar-test', 'healthy'],
        ['legacy-one', 'unmonitored'],
      ],
    );
    assert.equal(health.providers[0].products[0].dataAgeMs, 0);
    assert.ok(Array.isArray(health.history));
    const catalog = await get('/');
    assert.deepEqual(
      catalog.providers.map((p) => [p.id, p.health]),
      [
        ['radar-test', 'healthy'],
        ['legacy-one', 'unmonitored'],
      ],
    );
  } finally {
    registry.health.stop();
  }
});
