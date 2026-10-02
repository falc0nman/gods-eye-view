import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryTransport,
  createNotificationDispatcher,
  parseObjectNotification,
  s3NotificationMessage,
} from '../../server/providers/notifications/dispatcher.js';
import { createNotificationFeed } from '../../server/providers/notifications/feed.js';
import {
  createProviderRuntime,
  defineProvider,
} from '../../server/providers/common/provider.js';
import { createChunkListingFeed } from '../../server/providers/nexrad/level2Feed.js';

const CHUNKS = 'unidata-nexrad-level2-chunks';
const T0 = Date.parse('2026-10-02T20:00:00Z');

/** Manual clock and timer queue. */
function fakeClock(start = T0) {
  let time = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, at: time + ms });
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle),
    /** Run every timer due by now (once each). */
    runDue() {
      for (const [handle, timer] of [...timers]) {
        if (timer.at > time) continue;
        timers.delete(handle);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const chunk = (key, eventTime = T0) =>
  s3NotificationMessage({ bucket: CHUNKS, key, size: 100, eventTime });

test('notifications parse from SQS bodies, SNS envelopes and bare S3 events', () => {
  const expected = [
    {
      bucket: CHUNKS,
      key: 'KTLX/112/20261002-200000-001-S',
      size: 100,
      eventTime: T0,
    },
  ];
  const sqsBody = chunk('KTLX/112/20261002-200000-001-S');
  assert.deepEqual(parseObjectNotification(sqsBody), expected);
  assert.deepEqual(parseObjectNotification({ Body: sqsBody }), expected);
  const s3Event = JSON.parse(JSON.parse(sqsBody).Message);
  assert.deepEqual(parseObjectNotification(s3Event), expected);
  // URL-encoded keys, removals and junk.
  assert.equal(
    parseObjectNotification({
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: { bucket: { name: 'b' }, object: { key: 'a%3Ab+c' } },
        },
      ],
    })[0].key,
    'a:b c',
  );
  assert.deepEqual(
    parseObjectNotification({
      Records: [
        {
          eventName: 'ObjectRemoved:Delete',
          s3: { bucket: { name: 'b' }, object: { key: 'k' } },
        },
      ],
    }),
    [],
  );
  assert.deepEqual(parseObjectNotification('not json'), []);
});

test('the dispatcher drops unrequested objects early and measures latency per product', () => {
  const clock = fakeClock();
  const transport = createMemoryTransport();
  const dispatcher = createNotificationDispatcher({
    transport,
    now: clock.now,
  });
  const got = [];
  assert.equal(transport.running, false);
  const unsubscribe = dispatcher.subscribe({
    product: 'nexrad-level2-chunks',
    bucket: CHUNKS,
    match: (key) => key.startsWith('KTLX/'),
    emit: (object) => got.push(object),
  });
  assert.equal(transport.running, true);
  clock.advance(1_500);
  transport.publish(chunk('KTLX/112/20261002-200000-002-I'));
  transport.publish(chunk('KFWS/40/20261002-200000-002-I'));
  transport.publish(
    s3NotificationMessage({ bucket: 'other', key: 'KTLX/x', eventTime: T0 }),
  );
  assert.deepEqual(got, [
    {
      key: 'KTLX/112/20261002-200000-002-I',
      size: 100,
      lastModified: T0,
      notifiedAt: T0 + 1_500,
      via: 'notification',
    },
  ]);
  const status = dispatcher.status();
  assert.equal(status.state, 'flowing');
  assert.equal(status.messages, 3);
  assert.equal(status.unmatched, 2);
  assert.deepEqual(status.products['nexrad-level2-chunks'], {
    delivered: 1,
    objectToNotifyMs: { last: 1_500, median: 1_500 },
  });
  unsubscribe();
  assert.equal(transport.running, false);
  assert.equal(dispatcher.status().state, 'idle');
});

test('a transport that cannot start reports the stream down', () => {
  const dispatcher = createNotificationDispatcher({
    transport: {
      start() {
        throw new Error('no queue configured');
      },
    },
  });
  dispatcher.subscribe({
    product: 'p',
    bucket: 'b',
    match: () => true,
    emit() {},
  });
  assert.equal(dispatcher.status().state, 'down');
  assert.equal(dispatcher.status().lastError, 'no queue configured');
});

test('notifications reach a GW-80 push provider through its subscribe()', async () => {
  const transport = createMemoryTransport();
  const dispatcher = createNotificationDispatcher({ transport });
  const feed = createNotificationFeed({
    dispatcher,
    product: 'nexrad-level2-chunks',
    bucket: CHUNKS,
    match: (site, key) => key.startsWith(`${site}/`),
  });
  const provider = defineProvider({
    id: 'test-chunks',
    mode: 'push',
    source: { name: 'NOAA NEXRAD Level II' },
    subscribe: (_ctx, emit) => feed.watch('KTLX', emit),
    fetch: (item) => ({ bytes: item.size }),
    normalize: (raw, item) => ({
      validTime: item.lastModified,
      data: raw,
      provenance: { via: item.via, notifiedAt: item.notifiedAt },
    }),
  });
  const runtime = createProviderRuntime(provider);
  const records = [];
  const release = runtime.acquire((record) => records.push(record));
  transport.publish(chunk('KTLX/112/20261002-200000-002-I'));
  transport.publish(chunk('KTLX/112/20261002-200000-002-I')); // redelivered
  transport.publish(chunk('KEAX/9/20261002-200000-002-I'));
  await settle();
  assert.deepEqual(
    records.map((r) => [r.key, r.validTime, r.provenance.via]),
    [['KTLX/112/20261002-200000-002-I', T0, 'notification']],
  );
  assert.equal(feed.status('KTLX').state, 'live');
  release();
  assert.equal(transport.running, false);
});

test('a lapsed stream falls back to polling and switches back when messages resume', () => {
  const clock = fakeClock();
  const transport = createMemoryTransport();
  const dispatcher = createNotificationDispatcher({
    transport,
    lapseMs: 60_000,
    now: clock.now,
  });
  const polling = new Map();
  const fallback = {
    watch(site, emit) {
      polling.set(site, emit);
      return () => polling.delete(site);
    },
    status: () => ({ state: 'live', lastChunkAt: clock.now() }),
  };
  const feed = createNotificationFeed({
    dispatcher,
    product: 'nexrad-level2-chunks',
    bucket: CHUNKS,
    match: (site, key) => key.startsWith(`${site}/`),
    fallback,
    checkMs: 10_000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const got = [];
  const unwatch = feed.watch('KTLX', (object) => got.push(object.key));
  assert.equal(feed.status('KTLX').state, 'locating');

  clock.advance(61_000);
  clock.runDue();
  assert.equal(dispatcher.status().state, 'lapsed');
  assert.ok(polling.has('KTLX'));
  assert.equal(feed.status('KTLX').via, 'polling');
  polling.get('KTLX')({ key: 'KTLX/112/20261002-200100-003-I' });

  transport.publish(chunk('KTLX/112/20261002-200100-004-I', clock.now()));
  clock.advance(10_000);
  clock.runDue();
  assert.equal(polling.has('KTLX'), false);
  assert.equal(feed.status('KTLX').via, 'notifications');
  assert.equal(feed.status('KTLX').switches, 2);
  assert.deepEqual(got, [
    'KTLX/112/20261002-200100-003-I',
    'KTLX/112/20261002-200100-004-I',
  ]);
  unwatch();
  assert.equal(clock.pending(), 0);
  assert.equal(transport.running, false);
});

/** A fake chunk bucket: dir → keys, answered as ListObjectsV2 XML. */
function fakeChunkBucket(dirs) {
  const requests = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    requests.push(params.get('prefix'));
    const [site, slot] = params.get('prefix').split('/');
    const startAfter = params.get('start-after') || '';
    const keys = (dirs.get(Number(slot)) ?? [])
      .map((id) => `${site}/${slot}/${id}`)
      .filter((key) => key > startAfter)
      .sort();
    const body = keys
      .map(
        (key) =>
          `<Contents><Key>${key}</Key><LastModified>2026-10-02T20:00:00.000Z</LastModified><Size>1</Size></Contents>`,
      )
      .join('');
    return new Response(`<ListBucketResult>${body}</ListBucketResult>`);
  };
  return { fetchImpl, requests };
}

test('the polling fallback locates the live volume and follows it into the next one', async () => {
  // Volumes 1…999 cycle; slot 500 is being scanned now, 501 still holds an
  // older cycle's volume.
  const dirs = new Map();
  for (let slot = 1; slot <= 999; slot += 1) {
    const day = slot <= 500 ? '20261002' : '20261001';
    const hhmmss = String(100000 + slot * 10).slice(0, 6);
    dirs.set(slot, [`${day}-${hhmmss}-001-S`, `${day}-${hhmmss}-002-I`]);
  }
  const live = '20261002-105000';
  dirs.set(500, [`${live}-001-S`, `${live}-002-I`]);
  const { fetchImpl, requests } = fakeChunkBucket(dirs);
  const clock = fakeClock();
  const feed = createChunkListingFeed({
    fetchImpl,
    intervalMs: 4_000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const got = [];
  const unwatch = feed.watch('KTLX', (object) => got.push(object.key));
  for (let i = 0; i < 20 && !got.length; i += 1) await settle();
  assert.deepEqual(got, [`KTLX/500/${live}-001-S`, `KTLX/500/${live}-002-I`]);
  assert.ok(requests.length <= 14, `located in ${requests.length} listings`);
  assert.equal(feed.status('KTLX').state, 'live');

  // The volume ends; the next one starts in slot 501.
  dirs.get(500).push(`${live}-003-E`);
  const next = '20261002-105500';
  dirs.set(501, [...dirs.get(501), `${next}-001-S`]);
  clock.advance(4_000);
  clock.runDue();
  for (let i = 0; i < 5; i += 1) await settle();
  clock.advance(4_000);
  clock.runDue();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(got.slice(2), [
    `KTLX/500/${live}-003-E`,
    `KTLX/501/${next}-001-S`,
  ]);
  unwatch();
  assert.equal(feed.status('KTLX').state, 'idle');
});

test('a failing radar backs off instead of re-locating every few seconds', async () => {
  const delays = [];
  let requests = 0;
  const feed = createChunkListingFeed({
    fetchImpl: async () => {
      requests += 1;
      return new Response('busy', { status: 503 });
    },
    intervalMs: 4_000,
    maxBackoffMs: 120_000,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return delays.length;
    },
    clearTimeout() {},
  });
  const unwatch = feed.watch('KZZZ', () => {});
  for (let i = 0; i < 20 && !delays.length; i += 1) await settle();
  assert.equal(feed.status('KZZZ').state, 'unavailable');
  assert.equal(delays[0], 8_000);
  assert.equal(requests, 1, 'the first failed listing stops the locate');
  unwatch();
});
