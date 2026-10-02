import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderRuntime,
  createRecord,
  defineProvider,
  ProviderStageError,
} from '../../server/providers/common/provider.js';
import { createProviderRegistry } from '../../server/providers/registry.js';
import { localProviderRegistry } from '../../server/providers/local.js';

const source = { name: 'Test Bucket', url: 'https://example.test' };

function pullProvider(overrides = {}) {
  return defineProvider({
    id: 'test-pull',
    mode: 'pull',
    source,
    pollMs: 5_000,
    discover: () => [{ key: 'a' }, { key: 'b' }],
    fetch: (item) => `raw:${item.key}`,
    decode: (raw) => raw.toUpperCase(),
    normalize: (decoded, item) => ({
      validTime: 1_000,
      data: decoded,
      provenance: { object: item.key },
    }),
    ...overrides,
  });
}

/** A manual clock and timer queue so polling is deterministic. */
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle),
    pending: () => [...timers.values()],
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('defineProvider enforces the lifecycle each mode needs', () => {
  assert.throws(() => defineProvider({ id: 'Bad Id' }), /kebab-case/);
  assert.throws(
    () => pullProvider({ discover: undefined }),
    /must implement discover/,
  );
  assert.throws(() => pullProvider({ pollMs: 10 }), /pollMs/);
  assert.throws(() => pullProvider({ normalize: undefined }), /normalize/);
  assert.throws(() => pullProvider({ source: {} }), /source.name/);
  assert.throws(
    () =>
      defineProvider({
        id: 'test-push',
        mode: 'push',
        source,
        normalize: () => null,
      }),
    /must implement subscribe/,
  );
  const provider = pullProvider();
  assert.ok(Object.isFrozen(provider));
  assert.equal(provider.mode, 'pull');
});

test('records carry source, valid time, ingest time and provenance', () => {
  const provider = pullProvider();
  const record = createRecord(
    provider,
    {
      validTime: new Date('2026-10-02T01:09:25Z'),
      data: 1,
      provenance: { etag: 'x' },
    },
    { item: { key: 'obj/1' }, ingestTime: 2_000 },
  );
  assert.deepEqual(record, {
    key: 'obj/1',
    source: { name: 'Test Bucket', url: 'https://example.test' },
    validTime: Date.parse('2026-10-02T01:09:25Z'),
    ingestTime: 2_000,
    product: null,
    provenance: {
      provider: 'test-pull',
      mode: 'pull',
      item: 'obj/1',
      etag: 'x',
    },
    data: 1,
  });
  assert.throws(
    () => createRecord(provider, { data: 1 }, { ingestTime: 1 }),
    /validTime/,
  );
});

test('a pull cycle runs every stage once per new item', async () => {
  const provider = pullProvider();
  const runtime = createProviderRuntime(provider, { now: () => 9_000 });
  const got = [];
  runtime.acquire((record) => got.push(record));
  await runtime.poll();
  await runtime.poll();
  runtime.stop();
  assert.deepEqual(
    got.map((r) => [r.key, r.data, r.ingestTime, r.provenance.object]),
    [
      ['a', 'RAW:A', 9_000, 'a'],
      ['b', 'RAW:B', 9_000, 'b'],
    ],
  );
  assert.equal(runtime.latest().key, 'b');
  assert.equal(runtime.status().published, 2);
});

test('a failing stage is reported and retried without blocking other items', async () => {
  let attempts = 0;
  const errors = [];
  const provider = pullProvider({
    decode: (raw) => {
      if (raw === 'raw:a' && attempts++ === 0) throw new Error('truncated');
      return raw;
    },
  });
  const runtime = createProviderRuntime(provider, {
    onError: (error) => errors.push(error),
  });
  const got = [];
  runtime.acquire((record) => got.push(record.key));
  await runtime.poll();
  assert.deepEqual(got, ['b']);
  assert.ok(errors[0] instanceof ProviderStageError);
  assert.equal(errors[0].stage, 'decode');
  assert.equal(errors[0].itemKey, 'a');
  assert.equal(runtime.status().lastError.stage, 'decode');
  await runtime.poll();
  assert.deepEqual(got, ['b', 'a']);
  runtime.stop();
});

test('pull providers poll only while acquired', async () => {
  const timers = fakeTimers();
  let discovered = 0;
  const runtime = createProviderRuntime(
    pullProvider({
      discover: () => {
        discovered += 1;
        return [];
      },
    }),
    timers,
  );
  const release = runtime.acquire();
  const releaseSecond = runtime.acquire();
  await settle();
  assert.equal(discovered, 1);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].ms, 5_000);
  release();
  assert.equal(runtime.status().running, true);
  releaseSecond();
  assert.equal(runtime.status().running, false);
  assert.equal(timers.pending().length, 0);
});

test('push providers ingest emitted items and unsubscribe on release', async () => {
  let emit;
  let unsubscribed = false;
  const provider = defineProvider({
    id: 'test-push',
    mode: 'push',
    source,
    subscribe: (_ctx, push) => {
      emit = push;
      return () => {
        unsubscribed = true;
      };
    },
    normalize: (payload) => ({ validTime: payload.t, data: payload.v }),
  });
  const runtime = createProviderRuntime(provider, { now: () => 50 });
  const got = [];
  const release = runtime.acquire((record) => got.push(record));
  emit({ key: 'chunk-1', t: 10, v: 'x' });
  emit({ key: 'chunk-1', t: 10, v: 'x' }); // redelivery is ignored
  emit({ key: 'chunk-2', t: 20, v: 'y' });
  await settle();
  assert.deepEqual(
    got.map((r) => [r.key, r.validTime, r.ingestTime, r.provenance.mode]),
    [
      ['chunk-1', 10, 50, 'push'],
      ['chunk-2', 20, 50, 'push'],
    ],
  );
  release();
  assert.equal(unsubscribed, true);
});

test('the registry keeps one entry per id and lists provider status', () => {
  const registry = createProviderRegistry();
  registry.registerLegacy('legacy-one', () => ({ name: 'legacy-one' }));
  const runtime = registry.register(pullProvider());
  assert.throws(
    () => registry.registerLegacy('test-pull', () => ({})),
    /already registered/,
  );
  assert.equal(registry.get('test-pull'), runtime);
  assert.deepEqual(
    registry.plugins().map((plugin) => plugin.name),
    ['gev-provider-catalog', 'legacy-one', 'gev-provider-test-pull'],
  );
  const [legacy, provider] = registry.list();
  assert.deepEqual(legacy, { id: 'legacy-one', kind: 'legacy' });
  assert.equal(provider.mode, 'pull');
  assert.equal(provider.running, false);
});

test('GET /api/providers reports the registered providers', () => {
  const registry = createProviderRegistry();
  registry.register(pullProvider());
  let handler;
  registry.plugins()[0].configureServer({
    middlewares: {
      use: (path, fn) => path === '/api/providers' && (handler = fn),
    },
  });
  let status;
  let body;
  handler(
    { method: 'GET', url: '/' },
    {
      writeHead: (code) => (status = code),
      end: (text) => (body = JSON.parse(text)),
    },
    () => assert.fail('catalog route should answer'),
  );
  assert.equal(status, 200);
  assert.equal(body.providers[0].id, 'test-pull');
  assert.equal(body.providers[0].source.name, 'Test Bucket');
});

test('every local provider registers centrally', () => {
  const ids = localProviderRegistry()
    .list()
    .map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('nexrad-level3'));
  assert.equal(ids.at(-1), 'fire-perimeters');
});

test('provenance availableAt yields availability-to-ingest latency', async () => {
  const runtime = createProviderRuntime(
    pullProvider({
      normalize: (decoded, item) => ({
        validTime: 1_000,
        data: decoded,
        provenance: { availableAt: item.key === 'a' ? 8_000 : 8_500 },
      }),
    }),
    { now: () => 9_000 },
  );
  runtime.acquire();
  await runtime.poll();
  runtime.stop();
  assert.deepEqual(runtime.status().availableToIngestMs, {
    last: 500,
    median: 750,
    samples: 2,
  });
});

test('the catalog reports registered streams and survives a failing one', () => {
  const registry = createProviderRegistry();
  registry.registerStream('notifications', () => ({ state: 'flowing' }));
  registry.registerStream('broken', () => {
    throw new Error('boom');
  });
  assert.throws(() => registry.registerStream('broken', () => ({})), /already/);
  let handler;
  registry.plugins()[0].configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  let body;
  handler(
    { method: 'GET', url: '/' },
    { writeHead() {}, end: (text) => (body = JSON.parse(text)) },
    () => assert.fail('catalog route should answer'),
  );
  assert.deepEqual(body.streams, {
    notifications: { state: 'flowing' },
    broken: { state: 'error', error: 'boom' },
  });
});
