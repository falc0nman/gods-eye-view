import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Bunzip from 'seek-bzip';
import {
  decodeLevel2,
  readLevel2Records,
  RADIAL_STATUS,
} from '../../../server/providers/nexrad/level2.js';
import {
  createVolumeAssembler,
  parseChunkKey,
  parseVolumeKey,
  sweepProduct,
} from '../../../server/providers/nexrad/level2Volume.js';
import { renderLevel3 } from '../../../server/providers/nexrad/render.js';
import { createLevel2Ingest } from '../../../server/providers/nexrad-level2.js';
import {
  createMemoryTransport,
  createNotificationDispatcher,
  s3NotificationMessage,
} from '../../../server/providers/notifications/dispatcher.js';
import { unconfiguredTransport } from '../../../server/providers/notifications/transport.js';
import { createProviderRegistry } from '../../../server/providers/registry.js';

// KTLX volume 112 (VCP 212), 2026-09-30 18:29:08Z, from
// unidata-nexrad-level2-chunks: the start chunk (metadata only) and chunk 33
// (radials 121–240 of tilt 6, 1.3°, with REF/VEL/SW).
const VOLUME = '20260930-182908';
const S_KEY = `KTLX/112/${VOLUME}-001-S`;
const I_KEY = `KTLX/112/${VOLUME}-033-I`;
const fixture = (suffix) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../data/fixtures/level2-KTLX-${VOLUME}-${suffix}.bin`,
        import.meta.url,
      ),
    ),
  );
const S_CHUNK = fixture('001-S');
const I_CHUNK = fixture('033-I');
const bunzip = (data) => Bunzip.decode(Buffer.from(data));
const VOLUME_START = Date.parse('2026-09-30T18:29:08.154Z');
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test('the start chunk carries the volume header and no radials', () => {
  const { volume, radials } = decodeLevel2(S_CHUNK, { bunzip });
  assert.deepEqual(volume, {
    version: 'AR2V0006',
    startMs: VOLUME_START,
    icao: 'KTLX',
  });
  assert.equal(radials.length, 0);
});

test('an intermediate chunk decodes to 120 super-res radials of one tilt', () => {
  const { volume, radials } = decodeLevel2(I_CHUNK, { bunzip });
  assert.equal(volume, null);
  assert.equal(radials.length, 120);
  const first = radials[0];
  assert.equal(first.icao, 'KTLX');
  assert.equal(
    new Date(first.timeMs).toISOString(),
    '2026-09-30T18:30:52.879Z',
  );
  assert.equal(first.elevationNumber, 6);
  assert.ok(Math.abs(first.elevationDeg - 1.32) < 0.01);
  assert.equal(first.azimuthSpacingDeg, 0.5);
  assert.deepEqual(
    [first.azimuthNumber, radials.at(-1).azimuthNumber],
    [121, 240],
  );
  assert.ok(radials.every((r) => r.status === RADIAL_STATUS.INTERMEDIATE));
  assert.equal(first.vcp, 212);
  assert.deepEqual(
    [first.site.lat.toFixed(3), first.site.lon.toFixed(3)],
    ['35.333', '-97.278'],
  );
  assert.deepEqual(Object.keys(first.moments), ['REF', 'VEL', 'SW']);
  const vel = first.moments.VEL;
  assert.deepEqual(
    [vel.gates, vel.firstGateM, vel.gateM, vel.wordSize, vel.scale, vel.offset],
    [1192, 2125, 250, 8, 2, 129],
  );
  // Only the requested moments are kept.
  const lean = decodeLevel2(I_CHUNK, { bunzip, moments: ['REF'] });
  assert.deepEqual(Object.keys(lean.radials[0].moments), ['REF']);
});

test('a truncated chunk is rejected rather than half-decoded', () => {
  assert.throws(
    () => readLevel2Records(I_CHUNK.subarray(0, 4_000), { bunzip }),
    /Truncated/,
  );
});

test('chunk and volume keys parse to the same volume id', () => {
  assert.deepEqual(parseChunkKey(I_KEY), {
    site: 'KTLX',
    volumeNumber: 112,
    volumeId: VOLUME,
    sequence: 33,
    chunkType: 'I',
  });
  assert.equal(parseChunkKey('KTLX/112/nope'), null);
  assert.deepEqual(
    parseVolumeKey(`2026/09/30/KTLX/KTLX${VOLUME.replace('-', '_')}_V06`),
    { site: 'KTLX', volumeId: VOLUME },
  );
  assert.equal(
    parseVolumeKey('2026/09/30/KTLX/KTLX20260930_182908_V06_MDM'),
    null,
  );
});

function chunkRecord(key, bytes, ingestTime) {
  const decoded = decodeLevel2(bytes, { bunzip, moments: ['REF', 'VEL'] });
  return {
    data: { key: parseChunkKey(key), ...decoded },
    ingestTime,
    provenance: { lastModified: ingestTime - 1_000 },
  };
}

test('sweeps assemble as chunks arrive, in any order and without double counting', () => {
  const assembler = createVolumeAssembler({ now: () => 0 });
  const ingest = VOLUME_START + 110_000;
  assembler.addChunk(chunkRecord(I_KEY, I_CHUNK, ingest));
  assembler.addChunk(chunkRecord(I_KEY, I_CHUNK, ingest)); // redelivered
  assembler.addChunk(chunkRecord(S_KEY, S_CHUNK, ingest));
  const volume = assembler.newestVolume('KTLX');
  assert.equal(volume.id, VOLUME);
  assert.equal(volume.startMs, VOLUME_START);
  assert.equal(volume.vcp, 212);
  assert.equal(volume.complete, false);
  const sweep = assembler.sweep('KTLX', VOLUME, 6);
  assert.equal(sweep.radials.size, 120);
  assert.equal(sweep.complete, false);

  const latency = assembler.latency('KTLX');
  assert.equal(latency.samples, 2); // the S chunk has no radials to time
  assert.equal(latency.objectToIngestMs.last, 1_000);
  assert.ok(latency.radialToIngestMs.last > 0);

  // A radial marking the end of the elevation completes the sweep.
  const { radials } = decodeLevel2(I_CHUNK, { bunzip, moments: ['REF'] });
  const last = { ...radials.at(-1), status: RADIAL_STATUS.END_ELEVATION };
  assembler.addChunk({
    data: {
      key: { ...parseChunkKey(I_KEY), sequence: 34 },
      volume: null,
      radials: [last],
    },
    ingestTime: ingest,
    provenance: {},
  });
  assert.equal(assembler.sweep('KTLX', VOLUME, 6).complete, true);
  assert.equal(assembler.latency('KTLX').samples, 3);

  // Backfilled chunks predate the watch and are not latency samples.
  assembler.addChunk({
    ...chunkRecord(I_KEY, I_CHUNK, ingest),
    provenance: { lastModified: 0, backfill: true },
  });
  assert.equal(assembler.latency('KTLX').samples, 3);
});

test('a partial sweep renders as the wedge scanned so far', () => {
  const assembler = createVolumeAssembler();
  assembler.addChunk(chunkRecord(I_KEY, I_CHUNK, VOLUME_START));
  const volume = assembler.newestVolume('KTLX');
  const product = sweepProduct(
    assembler.sweep('KTLX', VOLUME, 6),
    'VEL',
    volume.location,
  );
  assert.equal(product.group, 'vel');
  assert.equal(product.gateKm, 0.25);
  assert.equal(product.firstBin, 8); // 2.125 km gate centre → 2.0 km edge
  assert.equal(product.radials.length, 120);
  assert.equal(product.valueOf(0), null);
  assert.equal(product.valueOf(1), 'RF');
  assert.equal(product.valueOf(129), 0);
  const image = renderLevel3(product, { maxSize: 512 });
  let painted = 0;
  for (let i = 3; i < image.rgba.length; i += 4)
    if (image.rgba[i]) painted += 1;
  // Radials 121–240 span about 60°–120°: a sixth of the disc at most.
  assert.ok(painted > 0 && painted < (image.width * image.height) / 6);
  assert.equal(
    sweepProduct(assembler.sweep('KTLX', VOLUME, 6), 'SW', volume.location),
    null,
  );
});

/** Fake NOAA buckets: chunk objects, chunk listings and completed volumes. */
function fakeNoaa({ chunks = {}, volumes = {}, listChunks = true } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    requests.push(u.host + u.pathname + u.search);
    const listing = (keys) =>
      new Response(
        `<ListBucketResult>${keys
          .map(
            (key) =>
              `<Contents><Key>${key}</Key><LastModified>2026-09-30T18:40:00.000Z</LastModified><Size>1</Size></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    const store = u.host.startsWith('unidata-nexrad-level2-chunks')
      ? chunks
      : volumes;
    if (u.pathname === '/') {
      const prefix = u.searchParams.get('prefix');
      if (store === chunks && !listChunks) return listing([]);
      return listing(Object.keys(store).filter((k) => k.startsWith(prefix)));
    }
    const body = store[decodeURIComponent(u.pathname.slice(1))];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  };
  return { fetchImpl, requests };
}

function mount(ingest, runtimeOptions = {}) {
  const registry = createProviderRegistry();
  registry.register(ingest.provider, runtimeOptions);
  let handler;
  for (const plugin of registry.plugins())
    plugin.configureServer({
      middlewares: {
        use: (path, fn) => {
          if (path === '/api/radar/l2') handler = fn;
        },
      },
    });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ url }, res);
    });
  return { registry, call };
}

test('notified chunks reach clients as partial sweeps with measured latency', async () => {
  const now = Date.parse('2026-09-30T18:31:05Z');
  const { fetchImpl } = fakeNoaa({
    chunks: { [S_KEY]: S_CHUNK, [I_KEY]: I_CHUNK },
    // Notifications only: backfill finds nothing to race them.
    listChunks: false,
  });
  const transport = createMemoryTransport();
  const dispatcher = createNotificationDispatcher({
    transport,
    now: () => now,
  });
  const ingest = createLevel2Ingest({ fetchImpl, dispatcher, now: () => now });
  const { registry, call } = mount(ingest, { now: () => now });
  try {
    // The first request watches the site; backfill lists the (fake) bucket.
    const first = JSON.parse((await call('/live?site=KTLX')).body);
    assert.equal(first.feed.via, 'notifications');
    assert.equal(transport.running, true);

    // A new volume's start chunk alone has nothing to draw.
    transport.publish(
      s3NotificationMessage({
        bucket: 'unidata-nexrad-level2-chunks',
        key: S_KEY,
        eventTime: now - 800,
      }),
    );
    await settle();
    const started = JSON.parse((await call('/live?site=KTLX')).body);
    assert.equal(started.volume, null);
    assert.equal(started.nextVolume, VOLUME);

    for (const key of [S_KEY, I_KEY])
      transport.publish(
        s3NotificationMessage({
          bucket: 'unidata-nexrad-level2-chunks',
          key,
          eventTime: now - 800,
        }),
      );
    await settle();
    const live = JSON.parse((await call('/live?site=KTLX')).body);
    assert.equal(live.mode, 'chunks');
    assert.equal(live.volume.id, VOLUME);
    assert.equal(live.volume.number, 112);
    assert.equal(live.volume.complete, false);
    assert.equal(live.nextVolume, null);
    assert.equal(live.sweeps.length, 1);
    const [sweep] = live.sweeps;
    assert.equal(sweep.elevationNumber, 6);
    assert.equal(sweep.radials, 120);
    assert.equal(sweep.expectedRadials, 720);
    assert.equal(sweep.complete, false);
    assert.ok(sweep.dataAgeMs >= 0);
    assert.deepEqual(Object.keys(sweep.images), ['REF', 'VEL']);
    assert.equal(live.latency.objectToIngestMs.last, 800);

    const png = await call(sweep.images.VEL.replace('/api/radar/l2', ''));
    assert.equal(png.status, 200);
    assert.equal(png.headers['Content-Type'], 'image/png');
    assert.equal(png.headers['Cache-Control'], 'public, max-age=60');
    assert.deepEqual([...png.body.subarray(1, 4)], [0x50, 0x4e, 0x47]);

    const status = registry.list()[0];
    assert.equal(status.running, true);
    assert.equal(status.published, 2);
    assert.equal(status.availableToIngestMs.last, 800);
    assert.equal(
      dispatcher.status().products['nexrad-level2-chunks'].delivered,
      3, // the start chunk was announced twice; the runtime kept it once
    );
  } finally {
    ingest.close();
  }
  assert.equal(transport.running, false);
});

test('with no chunk feed the newest completed volume is served instead', async () => {
  const now = Date.parse('2026-09-30T18:40:00Z');
  const volumeKey = `2026/09/30/KTLX/KTLX${VOLUME.replace('-', '_')}_V06`;
  // A volume file is the header plus LDM records, like these two chunks.
  const volumeFile = new Uint8Array(S_CHUNK.length + I_CHUNK.length);
  volumeFile.set(S_CHUNK);
  volumeFile.set(I_CHUNK, S_CHUNK.length);
  const { fetchImpl } = fakeNoaa({ volumes: { [volumeKey]: volumeFile } });
  const dispatcher = createNotificationDispatcher({
    transport: unconfiguredTransport(),
  });
  const ingest = createLevel2Ingest({ fetchImpl, dispatcher, now: () => now });
  const { call } = mount(ingest);
  try {
    await call('/live?site=KTLX');
    await settle();
    const live = JSON.parse((await call('/live?site=KTLX')).body);
    assert.equal(live.feed.via, 'polling');
    assert.equal(live.feed.state, 'unavailable');
    assert.equal(live.mode, 'volume');
    assert.equal(live.volume.id, VOLUME);
    assert.equal(live.volume.complete, true);
    assert.equal(live.sweeps[0].complete, true);
    const png = await call(
      live.sweeps[0].images.REF.replace('/api/radar/l2', ''),
    );
    assert.equal(
      png.headers['Cache-Control'],
      'public, max-age=86400, immutable',
    );
  } finally {
    ingest.close();
  }
});

test('bad requests are refused before any upstream work', async () => {
  const { fetchImpl, requests } = fakeNoaa();
  const ingest = createLevel2Ingest({ fetchImpl });
  const { call } = mount(ingest);
  try {
    assert.equal((await call('/live?site=../x')).status, 400);
    assert.equal((await call(`/image/KTLX/${VOLUME}/6/ZDR.png`)).status, 404);
    assert.equal((await call(`/image/KTLX/${VOLUME}/6/REF.png`)).status, 404);
    assert.equal(requests.length, 0);
  } finally {
    ingest.close();
  }
});
