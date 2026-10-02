import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createLevel3Ingest,
  createLevel3Service,
  level3KeyTime,
} from '../../../server/providers/nexrad.js';
import { routeCaller } from '../../tooling/providerRouteHarness.mjs';
import { createProviderRegistry } from '../../../server/providers/registry.js';
import { localProviderRegistry } from '../../../server/providers/local.js';

// KTLX storm-relative velocity (N0S), 2026-10-02 01:09:25Z.
const N0S = new Uint8Array(
  readFileSync(
    new URL(
      '../../data/fixtures/level3-KTLX-N0S-20261002-0109.bin',
      import.meta.url,
    ),
  ),
);
const KEY = 'TLX_N0S_2026_10_02_01_09_25';
const SCAN_MS = Date.parse('2026-10-02T01:09:25Z');
const MIN = 60_000;
const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

/** A manual clock and timer queue. */
function fakeClock(start = SCAN_MS + 2 * MIN) {
  let t = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, at: t + ms });
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle),
    runDue() {
      for (const [handle, timer] of [...timers])
        if (timer.at <= t) {
          timers.delete(handle);
          timer.fn();
        }
    },
  };
}

/** Fake unidata-nexrad-level3 bucket: `objects` maps key → bytes. */
function fakeBucket(objects, { failPrefix = null } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    requests.push(u.pathname + u.search);
    if (u.pathname === '/') {
      const prefix = u.searchParams.get('prefix');
      if (failPrefix && prefix.startsWith(failPrefix))
        return new Response('busy', { status: 503 });
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix));
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join('')}</ListBucketResult>`,
      );
    }
    const body = objects[u.pathname.slice(1)];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  };
  return { fetchImpl, requests };
}

function setup({ objects = { [KEY]: N0S }, failPrefix } = {}) {
  const clock = fakeClock();
  const bucket = fakeBucket(objects, { failPrefix });
  const service = createLevel3Service({
    fetchImpl: bucket.fetchImpl,
    now: clock.now,
  });
  const ingest = createLevel3Ingest({
    service,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const registry = createProviderRegistry({
    runtimeOptions: {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onError: () => {},
    },
  });
  const runtime = registry.register(ingest.provider);
  // Called as the backend calls them: exact path, behind feed:read.
  const call = routeCaller(registry, { prefix: '/api/radar/l3' });
  const health = () =>
    registry.health.evaluate().providers.find((p) => p.id === 'nexrad-level3');
  return { clock, bucket, ingest, registry, runtime, call, health, objects };
}

test('scan keys carry their scan time', () => {
  assert.equal(level3KeyTime(KEY), SCAN_MS);
  assert.ok(Number.isNaN(level3KeyTime('nope')));
});

test('/scan answers exactly as before, and publishes the scan through the provider', async () => {
  const { ingest, runtime, call, health } = setup();
  try {
    const res = await call('/scan?site=TLX&product=N0S');
    assert.equal(res.status, 200);
    const meta = JSON.parse(res.body);
    assert.deepEqual(Object.keys(meta).sort(), [
      'bounds',
      'elevationDeg',
      'image',
      'key',
      'product',
      'scanMs',
      'site',
    ]);
    assert.equal(meta.key, KEY);
    assert.equal(meta.scanMs, SCAN_MS);
    assert.equal(meta.image, `/api/radar/l3/image?key=${KEY}`);

    assert.deepEqual(ingest.watched(), ['TLX/N0S']);
    assert.equal(runtime.status().running, true);
    const record = runtime.latest();
    assert.equal(record.key, KEY);
    assert.equal(record.product, 'TLX/N0S');
    assert.equal(record.validTime, SCAN_MS);
    assert.equal(record.data.image, meta.image);

    const h = health();
    assert.equal(h.state, 'healthy');
    assert.deepEqual(
      h.products.map((p) => [p.product, p.dataAgeMs, p.staleAfterMs]),
      [['TLX/N0S', 2 * MIN, 20 * MIN]],
    );

    // Image and value routes are unchanged.
    const png = await call(`/image?key=${KEY}`);
    assert.equal(png.status, 200);
    assert.equal(png.headers['Content-Type'], 'image/png');
    const value = JSON.parse(
      (await call(`/value?key=${KEY}&lat=35.5&lon=-97.2`)).body,
    );
    assert.equal(value.inRange, true);
    assert.equal(typeof value.beamHeightFt, 'number');
  } finally {
    ingest.close();
  }
});

test('while watched, new scans are picked up without a client request', async () => {
  const { clock, ingest, runtime, call, health, objects } = setup();
  try {
    await call('/scan?site=TLX&product=N0S');
    await settle(); // the poll that watching started
    // The layer keeps asking every couple of minutes (watch refreshed), but
    // no new scan arrives for twenty minutes: the pair goes stale.
    for (let k = 0; k < 10; k += 1) {
      clock.advance(2 * MIN);
      ingest.touch('TLX', 'N0S');
    }
    assert.equal(health().products[0].state, 'stale');
    // A new scan lands in the bucket; the next poll publishes it.
    const next = 'TLX_N0S_2026_10_02_01_30_00';
    objects[next] = N0S;
    clock.advance(1 * MIN); // past the 30 s listing cache
    await runtime.poll();
    assert.equal(runtime.latest().key, next);
    assert.equal(runtime.status().published, 2);
  } finally {
    ingest.close();
  }
});

test('a pair stops being polled a few minutes after its last request', async () => {
  const { clock, ingest, runtime, call, health } = setup();
  await call('/scan?site=TLX&product=N0S');
  clock.advance(7 * MIN);
  clock.runDue();
  assert.deepEqual(ingest.watched(), []);
  assert.equal(runtime.status().running, false);
  assert.equal(health().state, 'idle');
});

test('one failing radar does not hide the others', async () => {
  const { ingest, runtime, call } = setup({ failPrefix: 'FWS_' });
  try {
    await call('/scan?site=TLX&product=N0S');
    ingest.touch('FWS', 'N0S');
    const items = await ingest.provider.discover({});
    assert.deepEqual(
      items.map((i) => i.key),
      [KEY],
    );
    assert.equal(runtime.status().consecutiveFailures, 0);
  } finally {
    ingest.close();
  }
});

test('bad requests are refused before any upstream work', async () => {
  const { bucket, ingest, call } = setup();
  try {
    assert.equal((await call('/scan?site=TOOLONG&product=N0S')).status, 400);
    assert.equal((await call('/scan?site=TLX&product=XYZ')).status, 400);
    assert.equal((await call('/value?key=nope&lat=1&lon=1')).status, 400);
    assert.equal((await call('/elsewhere')).status, 404);
    assert.equal(bucket.requests.length, 0);
    assert.deepEqual(ingest.watched(), []);
  } finally {
    ingest.close();
  }
});

test('Level III is registered on the provider interface, not as a legacy proxy', () => {
  const entry = localProviderRegistry()
    .list()
    .find((e) => e.id === 'nexrad-level3');
  assert.equal(entry.kind, 'provider');
  assert.equal(entry.mode, 'pull');
});
