/**
 * Level II chunk feeds — SERVER-SIDE (server/providers/nexrad-level2.js).
 *
 * A feed tells the provider which chunk objects exist, one site at a time:
 *
 *   feed.watch(site, emit) → unwatch
 *     emit({ key, lastModified?, size? }) for every new chunk object
 *   feed.status(site) → { state, lastChunkAt, error? }
 *     state: 'locating' | 'live' | 'stale' | 'unavailable'
 *
 * The event-driven feed built on NOAA's new-object notifications (GW-81)
 * implements this same shape. Until then, `createChunkListingFeed` watches
 * the current volume's prefix in `unidata-nexrad-level2-chunks`. It costs one
 * small list request per watched site every few seconds, and only while the
 * site is watched.
 */

import { parseChunkKey } from './level2Volume.js';

/** Bucket name as S3 notifications name it. */
export const LEVEL2_CHUNK_BUCKET_NAME = 'unidata-nexrad-level2-chunks';
export const LEVEL2_CHUNK_BUCKET =
  'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';
export const LEVEL2_VOLUME_BUCKET =
  'https://unidata-nexrad-level2.s3.amazonaws.com';

/** Volume directories cycle 1…999 per site. */
const VOLUME_SLOTS = 999;

/** Parse an S3 ListObjectsV2 page into {key, lastModified, size}. */
export function parseBucketListing(xml) {
  return [...String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(
    ([, body]) => ({
      key: /<Key>([^<]+)<\/Key>/.exec(body)?.[1] ?? '',
      lastModified: Date.parse(
        /<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1] ?? '',
      ),
      size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? NaN),
    }),
  );
}

export async function listBucket(
  fetchImpl,
  bucket,
  { prefix, startAfter, signal },
) {
  const params = new URLSearchParams({ 'list-type': '2', prefix });
  if (startAfter) params.set('start-after', startAfter);
  const res = await fetchImpl(`${bucket}/?${params}`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`NOAA list HTTP ${res.status}`);
  return parseBucketListing(await res.text());
}

/**
 * The newest volume in one directory: directories are reused as the volume
 * number wraps, so a listing can hold chunks of an older cycle too.
 */
function newestGroup(objects) {
  let volumeId = null;
  for (const object of objects) {
    const key = parseChunkKey(object.key);
    if (key && (!volumeId || key.volumeId > volumeId)) volumeId = key.volumeId;
  }
  return volumeId;
}

const nextSlot = (n) => (n % VOLUME_SLOTS) + 1;

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.bucket]
 * @param {number} [options.intervalMs] - time between prefix listings.
 * @param {number} [options.staleMs] - no new chunk for this long → re-locate.
 */
export function createChunkListingFeed({
  fetchImpl = (...args) => fetch(...args),
  bucket = LEVEL2_CHUNK_BUCKET,
  intervalMs = 4_000,
  staleMs = 12 * 60_000,
  maxBackoffMs = 2 * 60_000,
  now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
} = {}) {
  /** @type {Map<string, object>} */
  const watches = new Map();

  const list = (site, slot, startAfter, signal) =>
    listBucket(fetchImpl, bucket, {
      prefix: `${site}/${slot}/`,
      startAfter,
      signal,
    });

  /**
   * Find the volume being scanned now. The newest volume id per directory
   * rises with the slot number except at the one wrap point, so a rotated
   * binary search finds it in about ten listings.
   */
  async function locate(site, signal) {
    const cache = new Map();
    const newest = async (slot) => {
      if (!cache.has(slot))
        cache.set(
          slot,
          newestGroup(await list(site, slot, null, signal)) ?? '',
        );
      return cache.get(slot);
    };
    let lo = 1;
    let hi = VOLUME_SLOTS;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await newest(mid)) > (await newest(hi))) lo = mid + 1;
      else hi = mid;
    }
    // `lo` holds the oldest volume; the newest is the slot before it.
    const slot = lo === 1 ? VOLUME_SLOTS : lo - 1;
    const volumeId = await newest(slot);
    if (!volumeId) throw new Error(`no Level II chunks for ${site}`);
    return { slot, volumeId };
  }

  function watch(site, emit) {
    if (watches.has(site)) throw new Error(`${site} is already watched`);
    const controller = new AbortController();
    const state = {
      state: 'locating',
      slot: null,
      volumeId: null,
      lastKey: null,
      lastChunkAt: null,
      error: null,
      failures: 0,
      timer: null,
    };
    watches.set(site, state);

    const deliver = (objects, extra = null) => {
      for (const object of objects) {
        const key = parseChunkKey(object.key);
        if (!key || key.volumeId !== state.volumeId) continue;
        state.lastKey = object.key;
        state.lastChunkAt = now();
        emit(extra ? { ...object, ...extra } : object);
        if (key.chunkType === 'E') return true;
      }
      return false;
    };

    async function tick() {
      const { signal } = controller;
      try {
        if (state.slot === null) {
          Object.assign(state, await locate(site, signal), { state: 'live' });
          state.lastChunkAt = now();
          // Chunks written before the watch began: not a latency sample.
          deliver(await list(site, state.slot, null, signal), {
            backfill: true,
          });
        } else {
          let objects = await list(site, state.slot, state.lastKey, signal);
          if (state.volumeId === null) {
            // Waiting for the next volume to start in the next directory.
            const volumeId = newestGroup(objects);
            if (volumeId && volumeId > state.previousVolumeId) {
              state.volumeId = volumeId;
            } else objects = [];
          }
          if (deliver(objects)) {
            state.previousVolumeId = state.volumeId;
            state.slot = nextSlot(state.slot);
            state.volumeId = null;
            state.lastKey = null;
          }
          state.state = now() - state.lastChunkAt > staleMs ? 'stale' : 'live';
          if (state.state === 'stale') state.slot = null; // re-locate
        }
        state.error = null;
        state.failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        state.error = String(error?.message || error);
        state.state = 'unavailable';
        state.slot = null;
        state.failures += 1;
      }
      if (signal.aborted) return;
      // Failing sites (an unknown id, an outage) back off to 2 minutes, so a
      // watch cannot keep re-running the ~10-listing locate every few seconds.
      const delay = Math.min(
        maxBackoffMs,
        intervalMs * 2 ** Math.min(state.failures, 10),
      );
      state.timer = schedule(tick, delay);
      state.timer?.unref?.();
    }
    tick();

    return () => {
      controller.abort();
      if (state.timer !== null) unschedule(state.timer);
      watches.delete(site);
    };
  }

  function status(site) {
    const state = watches.get(site);
    if (!state) return { state: 'idle', lastChunkAt: null };
    return {
      state: state.state,
      lastChunkAt: state.lastChunkAt,
      volumeNumber: state.slot,
      ...(state.error ? { error: state.error } : {}),
    };
  }

  /**
   * Announce the chunks already written for the volume being scanned now:
   * notifications only cover objects written after a site is first watched.
   */
  async function backfill(site, emit, { signal } = {}) {
    const { slot, volumeId } = await locate(site, signal);
    const objects = await list(site, slot, null, signal);
    for (const object of objects) {
      if (signal?.aborted) return;
      if (parseChunkKey(object.key)?.volumeId === volumeId)
        emit({ ...object, backfill: true });
    }
  }

  return { kind: 'listing', watch, status, backfill };
}
