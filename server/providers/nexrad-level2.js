import zlib from 'node:zlib';
import Bunzip from 'seek-bzip';
import { defineProvider } from './common/provider.js';
import { decodeLevel2 } from './nexrad/level2.js';
import { createNotificationFeed } from './notifications/feed.js';
import {
  createChunkListingFeed,
  LEVEL2_CHUNK_BUCKET,
  LEVEL2_CHUNK_BUCKET_NAME,
  LEVEL2_VOLUME_BUCKET,
  listBucket,
} from './nexrad/level2Feed.js';
import {
  createVolumeAssembler,
  expectedRadials,
  parseChunkKey,
  parseVolumeKey,
  supplementalCuts,
  sweepProduct,
} from './nexrad/level2Volume.js';
import { encodePng, renderLevel3 } from './nexrad/render.js';
import { parseStormMotion } from './nexrad/dealias.js';
import { sweepValueAt, velocityProduct } from './nexrad/level2Velocity.js';
import {
  createStormMotionSource,
  describeMotion,
} from './nexrad/stormMotion.js';

/** Image products: decoded moments plus the derived velocity products (GW-72). */
const IMAGE_PRODUCTS = Object.freeze(['REF', 'VEL', 'VDA', 'SRV']);

/**
 * NEXRAD Level II, ingested as real-time chunks (GW-74). It is the reference
 * implementation of the common provider interface (GW-80,
 * docs/DATA-PROVIDERS.md).
 *
 * Each chunk holds about 120 radials (a sixth of a super-res low tilt) and
 * reaches NOAA's bucket within seconds of being scanned, while the completed
 * volume file only appears after the whole 4–10 minute scan. Sweeps are
 * therefore published as their chunks arrive. When the chunk feed is
 * unavailable for a site, the newest completed volume from
 * `unidata-nexrad-level2` is served instead.
 *
 * Routes (backend shape; both need `feed:read`, GW-45):
 *   GET /api/radar/l2/live?site=KTLX
 *       → {site, mode, feed, volume, sweeps[], latency, generatedAt}
 *       Watches the site for the next few minutes; the response holds
 *       whatever has arrived so far. Only signed-in, authorized requests
 *       can start upstream ingest.
 *   GET /api/radar/l2/image?site&volume&elevation&product&rev[&motion]
 *       product REF, VEL, VDA (dealiased) or SRV (storm-relative, needs
 *       motion=DDD/SS; the vector applied is in X-Storm-Motion).
 *       A sweep as an equirectangular PNG over its coverage square (the
 *       same projection as Level III). In-progress sweeps render as the
 *       wedge scanned so far. Cached privately: images are authorized data.
 *   GET /api/radar/l2/value?site&volume&elevation&lat&lon[&motion]
 *       Raw, dealiased and storm-relative velocity and reflectivity at a
 *       point (couplet interrogation, GW-8).
 */

export const LEVEL2_MOMENTS_KEPT = Object.freeze(['REF', 'VEL']);
const SITE_RE = /^[A-Z][A-Z0-9]{3}$/;
const VOLUME_ID_RE = /^\d{8}-\d{6}$/;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_VOLUME_BYTES = 64 * 1024 * 1024;
const WATCH_TTL_MS = 3 * 60_000;
// Radars watched at once (each costs a few upstream listings a minute).
const MAX_WATCHED_SITES = 12;
const VOLUME_FALLBACK_TTL_MS = 60_000;
const MAX_IMAGES = 48;
const MAX_CONCURRENT_FETCHES = 4;

const bunzip = (data) => Bunzip.decode(Buffer.from(data));

async function readBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error('Upstream response too large');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes)
    throw new Error('Upstream response too large');
  return new Uint8Array(buffer);
}

const dayPrefix = (ms) =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, '/');

/**
 * Chunks are announced by NOAA's notifications (GW-81) when a dispatcher is
 * supplied. The chunk-bucket listing backfills a newly watched site and
 * takes over whenever the notification stream lapses or is down.
 */
export function level2Feed({ dispatcher, fetchImpl, chunkBucket, now }) {
  const listing = createChunkListingFeed({
    fetchImpl,
    bucket: chunkBucket,
    now,
  });
  if (!dispatcher) return listing;
  return createNotificationFeed({
    dispatcher,
    product: 'nexrad-level2-chunks',
    bucket: LEVEL2_CHUNK_BUCKET_NAME,
    match: (site, key) => key.startsWith(`${site}/`),
    fallback: listing,
    backfill: listing.backfill,
    now,
  });
}

/**
 * Chunk ingest, assembly, completed-volume fallback and routes. Exported for
 * tests: everything with I/O or time is injectable.
 */
export function createLevel2Ingest({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  chunkBucket = LEVEL2_CHUNK_BUCKET,
  volumeBucket = LEVEL2_VOLUME_BUCKET,
  dispatcher = null,
  feed = level2Feed({ dispatcher, fetchImpl, chunkBucket, now }),
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  stormMotion = createStormMotionSource({ fetchImpl, now }),
} = {}) {
  const assembler = createVolumeAssembler({ now });
  /** site → {expiresAt, unwatch} */
  const watched = new Map();
  /** site → {at, promise} */
  const fallbacks = new Map();
  /** image cache key → {png, complete}, insertion-ordered LRU */
  const images = new Map();
  let emitChunk = null;
  let runtime = null;
  let release = null;
  let reaper = null;
  let active = 0;
  const waiting = [];

  /** Locating mid-volume emits dozens of chunks at once; fetch a few at a time. */
  async function limited(task) {
    if (active >= MAX_CONCURRENT_FETCHES)
      await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  // Watch expiry must never keep the server process alive on its own.
  const later = (fn, ms) => {
    const timer = schedule(fn, ms);
    timer?.unref?.();
    return timer;
  };

  function feedWatch(site) {
    const entry = watched.get(site);
    if (!entry || entry.unwatch || !emitChunk) return;
    entry.unwatch = feed.watch(site, emitChunk);
  }

  const provider = defineProvider({
    id: 'nexrad-level2',
    label: 'NEXRAD Level II (real-time chunks)',
    mode: 'push',
    source: {
      name: 'NOAA NEXRAD Level II',
      url: chunkBucket,
      license: 'NOAA open data (AWS Open Data Sponsorship Program)',
    },
    // Chunks arrive every few seconds while a radar scans; between volumes
    // the gap is well under a minute.
    health: {
      degradedAfterMs: 90_000,
      staleAfterMs: 5 * 60_000,
      check: () =>
        [...watched.keys()].flatMap((site) => {
          const feedState = feed.status(site);
          if (feedState.state === 'unavailable' || feedState.state === 'stale')
            return [
              {
                product: site,
                state: 'degraded',
                code: 'chunk_feed_down',
                reason: `chunk feed ${feedState.state}; serving completed volumes`,
              },
            ];
          return [];
        }),
    },
    subscribe(_ctx, emit) {
      emitChunk = (object) => emit(object);
      for (const site of watched.keys()) feedWatch(site);
      return () => {
        for (const entry of watched.values()) {
          entry.unwatch?.();
          entry.unwatch = null;
        }
        emitChunk = null;
      };
    },
    fetch: (item, { signal }) =>
      limited(async () => {
        const res = await fetchImpl(`${chunkBucket}/${item.key}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (!res.ok) throw new Error(`NOAA chunk HTTP ${res.status}`);
        return readBytesCapped(res, MAX_CHUNK_BYTES);
      }),
    decode: (bytes) =>
      decodeLevel2(bytes, { bunzip, moments: LEVEL2_MOMENTS_KEPT }),
    normalize(decoded, item) {
      const key = parseChunkKey(item.key);
      if (!key) throw new Error(`not a Level II chunk key: ${item.key}`);
      const times = decoded.radials.map((r) => r.timeMs);
      return {
        key: item.key,
        // Health and data age are tracked per radar.
        product: key.site,
        validTime: times.length
          ? Math.min(...times)
          : (decoded.volume?.startMs ?? item.lastModified),
        data: { key, volume: decoded.volume, radials: decoded.radials },
        provenance: {
          object: item.key,
          volumeNumber: key.volumeNumber,
          volumeId: key.volumeId,
          sequence: key.sequence,
          chunkType: key.chunkType,
          lastModified: item.lastModified ?? null,
          // When NOAA made the chunk available (notification or listing).
          // Backfilled chunks predate the watch, so they say nothing about
          // feed latency.
          availableAt: item.backfill ? null : (item.lastModified ?? null),
          via: item.via ?? 'listing',
          backfill: Boolean(item.backfill),
        },
      };
    },
    attach(providerRuntime) {
      runtime = providerRuntime;
    },
    close: () => close(),
    api: [
      {
        method: 'GET',
        path: '/api/radar/l2/live',
        permissions: ['feed:read'],
        handler: ({ query }) => live(query),
      },
      {
        method: 'GET',
        path: '/api/radar/l2/image',
        permissions: ['feed:read'],
        handler: ({ query }) => imageRoute(query),
      },
      {
        method: 'GET',
        path: '/api/radar/l2/value',
        permissions: ['feed:read'],
        handler: ({ query }) => valueRoute(query),
      },
    ],
  });

  function reap() {
    reaper = null;
    for (const [site, entry] of watched) {
      if (entry.expiresAt > now()) continue;
      entry.unwatch?.();
      watched.delete(site);
      assembler.forget(site);
      fallbacks.delete(site);
    }
    if (!watched.size) {
      release?.();
      release = null;
    } else reaper = later(reap, WATCH_TTL_MS);
  }

  /** Keep a site's feed running for a few more minutes. */
  function touch(site) {
    const entry = watched.get(site);
    if (entry) entry.expiresAt = now() + WATCH_TTL_MS;
    else watched.set(site, { expiresAt: now() + WATCH_TTL_MS, unwatch: null });
    if (runtime && !release)
      release = runtime.acquire((record) => assembler.addChunk(record));
    feedWatch(site);
    if (reaper === null) reaper = later(reap, WATCH_TTL_MS);
  }

  /** Load the newest completed volume (cached per site for a minute). */
  function completedVolume(site) {
    const cached = fallbacks.get(site);
    if (cached && now() - cached.at < VOLUME_FALLBACK_TTL_MS)
      return cached.promise;
    const promise = (async () => {
      let objects = [];
      for (const ms of [now(), now() - 86_400_000]) {
        objects = (
          await listBucket(fetchImpl, volumeBucket, {
            prefix: `${dayPrefix(ms)}/${site}/`,
          })
        ).filter((o) => parseVolumeKey(o.key));
        if (objects.length) break;
      }
      const newest = objects.sort((a, b) => (a.key < b.key ? -1 : 1)).at(-1);
      if (!newest) return null;
      const { volumeId } = parseVolumeKey(newest.key);
      if (assembler.hasVolume(site, volumeId)) return volumeId;
      const res = await fetchImpl(`${volumeBucket}/${newest.key}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`NOAA volume HTTP ${res.status}`);
      const bytes = await readBytesCapped(res, MAX_VOLUME_BYTES);
      assembler.addVolume(
        site,
        volumeId,
        decodeLevel2(bytes, { bunzip, moments: LEVEL2_MOMENTS_KEPT }),
      );
      return volumeId;
    })();
    promise.catch(() => fallbacks.delete(site));
    fallbacks.set(site, { at: now(), promise });
    return promise;
  }

  /** Product names a sweep can be drawn as (SRV only with a motion). */
  function sweepImages(site, volume, sweep, motion) {
    const has = (name) =>
      [...sweep.radials.values()].some((r) => r.moments[name]);
    const names = [];
    if (has('REF')) names.push('REF');
    if (has('VEL')) names.push('VEL', 'VDA', ...(motion ? ['SRV'] : []));
    return Object.fromEntries(
      names.map((name) => [
        name,
        `/api/radar/l2/image?${new URLSearchParams({
          site,
          volume: volume.id,
          elevation: String(sweep.elevationNumber),
          product: name,
          rev: String(sweep.revision),
          ...(name === 'SRV'
            ? {
                motion: `${Math.round(motion.fromDeg)}/${Math.round(motion.speedKt)}`,
              }
            : {}),
        })}`,
      ]),
    );
  }

  async function snapshot(site, { motion: motionRequest = null } = {}) {
    const feedStatus = feed.status(site);
    // A volume that has only its start chunk has nothing to draw yet; keep
    // serving the previous one and name the next.
    const started = assembler.newestVolume(site, { source: 'chunks' });
    let volume = assembler.newestVolume(site, {
      source: 'chunks',
      withSweeps: true,
    });
    const nextVolume = started && started !== volume ? started.id : null;
    let mode = volume ? 'chunks' : 'pending';
    // Serve the newest completed volume while the chunk feed cannot deliver:
    // nothing assembled yet, or the feed is unavailable or stale.
    if (
      !volume ||
      feedStatus.state === 'unavailable' ||
      feedStatus.state === 'stale'
    ) {
      try {
        if (await completedVolume(site)) {
          const completed = assembler.newestVolume(site, { source: 'volume' });
          if (completed && (!volume || completed.id > volume.id)) {
            volume = completed;
            mode = 'volume';
          }
        }
      } catch (error) {
        console.warn('[nexrad-l2] completed volume', error?.message || error);
      }
    }
    const resolved = await stormMotion.resolve(
      motionRequest,
      volume?.location ?? null,
    );
    const motion = resolved.motion;
    const t = now();
    return {
      site,
      mode,
      // Which storm motion SRV images use, and where it came from.
      stormMotion: motion,
      ...(resolved.error ? { stormMotionError: resolved.error } : {}),
      feed: { kind: feed.kind ?? 'custom', ...feedStatus },
      volume: volume && {
        id: volume.id,
        number: volume.number,
        source: volume.source,
        startMs: volume.startMs,
        vcp: volume.vcp,
        complete: volume.complete,
        location: volume.location,
      },
      sweeps: volume
        ? (() => {
            const sails = supplementalCuts(volume.sweeps.values());
            return [...volume.sweeps.values()]
              .sort((a, b) => a.elevationNumber - b.elevationNumber)
              .map((sweep) => ({
                elevationNumber: sweep.elevationNumber,
                elevationDeg: Math.round(sweep.elevationDeg * 100) / 100,
                radials: sweep.radials.size,
                expectedRadials: expectedRadials(sweep),
                complete: sweep.complete,
                firstRadialMs: sweep.firstRadialMs,
                lastRadialMs: sweep.lastRadialMs,
                // GW-25 data-age: how old the newest radial in the sweep is.
                dataAgeMs: t - sweep.lastRadialMs,
                // SAILS / MESO-SAILS: an extra low-level cut mid-volume.
                supplemental: sails.has(sweep.elevationNumber),
                ...(sails.has(sweep.elevationNumber)
                  ? { sailsCut: sails.get(sweep.elevationNumber) }
                  : {}),
                revision: sweep.revision,
                images: sweepImages(site, volume, sweep, motion),
              }));
          })()
        : [],
      nextVolume,
      latency: assembler.latency(site),
      generatedAt: t,
    };
  }

  /** Dealiasing anchors each sweep to the same tilt of the volume before. */
  const velocityOptions = (site) => ({
    referenceOf: (sweep) =>
      assembler.referenceSweep(site, sweep.volumeId, sweep.elevationNumber),
  });

  function sweepLocation(site, volumeId, sweep) {
    return (
      assembler.volume(site, volumeId)?.location ??
      [...sweep.radials.values()].find((r) => r.site)?.site ??
      null
    );
  }

  function image(site, volumeId, elevationNumber, moment, motion = null) {
    const sweep = assembler.sweep(site, volumeId, elevationNumber);
    if (!sweep) return null;
    const location = sweepLocation(site, volumeId, sweep);
    const motionKey = motion ? `${motion.fromDeg}/${motion.speedKt}` : '';
    const cacheKey = `${site}/${volumeId}/${elevationNumber}/${moment}/${sweep.revision}/${motionKey}`;
    if (images.has(cacheKey)) return images.get(cacheKey);
    const product =
      moment === 'VDA' || moment === 'SRV'
        ? velocityProduct(
            sweep,
            moment,
            location,
            motion,
            velocityOptions(site),
          )
        : sweepProduct(sweep, moment, location);
    if (!product) return null;
    const png = encodePng(renderLevel3(product), {
      deflate: (data) => zlib.deflateSync(data, { level: 6 }),
      crc32: zlib.crc32,
    });
    const result = { png, complete: sweep.complete };
    images.set(cacheKey, result);
    while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
    return result;
  }

  async function live(query) {
    const site = String(query.get('site') || '').toUpperCase();
    if (!SITE_RE.test(site))
      return {
        status: 400,
        body: { error: 'site must be a 4-letter radar id' },
      };
    if (!watched.has(site) && watched.size >= MAX_WATCHED_SITES)
      return {
        status: 429,
        body: { error: 'too many radars are being watched; try again shortly' },
      };
    touch(site);
    try {
      return {
        status: 200,
        body: await snapshot(site, { motion: query.get('motion') }),
      };
    } catch (err) {
      console.warn('[nexrad-l2]', err?.message || err);
      return { status: 502, body: { error: 'radar ingest failed' } };
    }
  }

  function imageRoute(query) {
    const site = String(query.get('site') || '').toUpperCase();
    const volumeId = String(query.get('volume') || '');
    const elevation = Number(query.get('elevation'));
    const product = String(query.get('product') || '').toUpperCase();
    if (
      !SITE_RE.test(site) ||
      !VOLUME_ID_RE.test(volumeId) ||
      !Number.isInteger(elevation) ||
      elevation < 1 ||
      elevation > 99 ||
      !IMAGE_PRODUCTS.includes(product)
    )
      return {
        status: 400,
        body: {
          error:
            'expected site, volume, elevation and product REF, VEL, VDA or SRV',
        },
      };
    // SRV images name their storm motion explicitly; `auto` is resolved by
    // /live first, so an image URL always means one exact picture.
    const motion =
      product === 'SRV' ? parseStormMotion(query.get('motion')) : null;
    if (product === 'SRV' && !motion)
      return { status: 400, body: { error: 'SRV needs motion=DDD/SS' } };
    const hit = image(site, volumeId, elevation, product, motion);
    if (!hit) return { status: 404, body: { error: 'sweep not available' } };
    return {
      status: 200,
      bytes: hit.png,
      contentType: 'image/png',
      // The URL carries the sweep revision, so even partial sweeps can be
      // cached briefly; complete ones never change. Private: only the
      // signed-in browser may keep authorized radar data.
      cacheControl: hit.complete
        ? 'private, max-age=86400, immutable'
        : 'private, max-age=60',
      ...(motion
        ? { headers: { 'X-Storm-Motion': describeMotion(motion) } }
        : {}),
    };
  }

  /**
   * Point values for interrogation (GW-8): raw, dealiased and storm-relative
   * velocity, and reflectivity.
   */
  function valueRoute(query) {
    const site = String(query.get('site') || '').toUpperCase();
    const volumeId = String(query.get('volume') || '');
    const elevation = Number(query.get('elevation'));
    const lat = Number(query.get('lat'));
    const lon = Number(query.get('lon'));
    const motionText = query.get('motion');
    const motion = motionText ? parseStormMotion(motionText) : null;
    if (
      !SITE_RE.test(site) ||
      !VOLUME_ID_RE.test(volumeId) ||
      !Number.isInteger(elevation) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (motionText && !motion)
    )
      return {
        status: 400,
        body: {
          error:
            'expected site, volume, elevation, lat, lon and optional motion=DDD/SS',
        },
      };
    const sweep = assembler.sweep(site, volumeId, elevation);
    const location = sweep && sweepLocation(site, volumeId, sweep);
    if (!sweep || !location)
      return { status: 404, body: { error: 'sweep not available' } };
    const hit = sweepValueAt(
      sweep,
      location,
      lat,
      lon,
      motion,
      velocityOptions(site),
    );
    const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    return {
      status: 200,
      body: {
        ...hit,
        rangeKm: round(hit.rangeKm),
        azimuthDeg: Math.round(hit.azimuthDeg),
        ref: round(hit.ref),
        vel: round(hit.vel),
        velDealiased: round(hit.velDealiased),
        srv: round(hit.srv),
        units: 'm/s (velocity), dBZ (ref)',
        stormMotion: motion && { ...motion, label: describeMotion(motion) },
      },
    };
  }

  function close() {
    if (reaper !== null) unschedule(reaper);
    reaper = null;
    release?.();
    release = null;
    for (const entry of watched.values()) entry.unwatch?.();
    watched.clear();
  }

  return { provider, assembler, snapshot, touch, close };
}

/** The provider definition the registry installs. */
export function nexradLevel2Provider(options) {
  return createLevel2Ingest(options).provider;
}
