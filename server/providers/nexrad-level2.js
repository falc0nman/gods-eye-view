import zlib from 'node:zlib';
import Bunzip from 'seek-bzip';
import { defineProvider } from './common/provider.js';
import { decodeLevel2 } from './nexrad/level2.js';
import {
  createChunkListingFeed,
  LEVEL2_CHUNK_BUCKET,
  LEVEL2_VOLUME_BUCKET,
  listBucket,
} from './nexrad/level2Feed.js';
import {
  createVolumeAssembler,
  expectedRadials,
  LEVEL2_RENDER_GROUPS,
  parseChunkKey,
  parseVolumeKey,
  sweepProduct,
} from './nexrad/level2Volume.js';
import { encodePng, renderLevel3 } from './nexrad/render.js';

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
 * Routes:
 *   GET /api/radar/l2/live?site=KTLX
 *       → {site, mode, feed, volume, sweeps[], latency, generatedAt}
 *       Watches the site for the next few minutes; the response holds
 *       whatever has arrived so far.
 *   GET /api/radar/l2/image/<SITE>/<volumeId>/<elevation>/<REF|VEL>.png
 *       A sweep as an equirectangular PNG over its coverage square (the
 *       same projection as Level III). In-progress sweeps render as the
 *       wedge scanned so far.
 */

export const LEVEL2_MOMENTS_KEPT = Object.freeze(['REF', 'VEL']);
const SITE_RE = /^[A-Z][A-Z0-9]{3}$/;
const VOLUME_ID_RE = /^\d{8}-\d{6}$/;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_VOLUME_BYTES = 64 * 1024 * 1024;
const WATCH_TTL_MS = 3 * 60_000;
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
 * Chunk ingest, assembly, completed-volume fallback and routes. Exported for
 * tests: everything with I/O or time is injectable.
 */
export function createLevel2Ingest({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  chunkBucket = LEVEL2_CHUNK_BUCKET,
  volumeBucket = LEVEL2_VOLUME_BUCKET,
  feed = createChunkListingFeed({ fetchImpl, bucket: chunkBucket, now }),
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
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
          availableAt: item.lastModified ?? null,
          via: item.via ?? 'listing',
        },
      };
    },
    routes(server, providerRuntime) {
      runtime = providerRuntime;
      server.middlewares.use('/api/radar/l2', handle);
    },
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

  async function snapshot(site) {
    const feedStatus = feed.status(site);
    let volume = assembler.newestVolume(site, { source: 'chunks' });
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
    const t = now();
    return {
      site,
      mode,
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
        ? [...volume.sweeps.values()]
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
              revision: sweep.revision,
              images: Object.fromEntries(
                Object.keys(LEVEL2_RENDER_GROUPS)
                  .filter((name) =>
                    [...sweep.radials.values()].some((r) => r.moments[name]),
                  )
                  .map((name) => [
                    name,
                    `/api/radar/l2/image/${site}/${volume.id}/${sweep.elevationNumber}/${name}.png?rev=${sweep.revision}`,
                  ]),
              ),
            }))
        : [],
      latency: assembler.latency(site),
      generatedAt: t,
    };
  }

  function image(site, volumeId, elevationNumber, moment) {
    const sweep = assembler.sweep(site, volumeId, elevationNumber);
    if (!sweep) return null;
    const location =
      assembler.volume(site, volumeId)?.location ??
      [...sweep.radials.values()].find((r) => r.site)?.site ??
      null;
    const cacheKey = `${site}/${volumeId}/${elevationNumber}/${moment}/${sweep.revision}`;
    if (images.has(cacheKey)) return images.get(cacheKey);
    const product = sweepProduct(sweep, moment, location);
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

  function sendJson(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://local');
    try {
      if (url.pathname === '/live') {
        const site = String(url.searchParams.get('site') || '').toUpperCase();
        if (!SITE_RE.test(site)) {
          sendJson(res, 400, { error: 'site must be a 4-letter radar id' });
          return;
        }
        touch(site);
        sendJson(res, 200, await snapshot(site));
        return;
      }
      const m =
        /^\/image\/([A-Z0-9]{4})\/([0-9-]+)\/(\d{1,2})\/([A-Z]{3})\.png$/.exec(
          url.pathname,
        );
      if (m && VOLUME_ID_RE.test(m[2]) && LEVEL2_RENDER_GROUPS[m[4]]) {
        const hit = image(m[1], m[2], Number(m[3]), m[4]);
        if (!hit) {
          sendJson(res, 404, { error: 'sweep not available' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          // The URL carries the sweep revision, so even partial sweeps can
          // be cached briefly; complete ones never change.
          'Cache-Control': hit.complete
            ? 'public, max-age=86400, immutable'
            : 'public, max-age=60',
        });
        res.end(hit.png);
        return;
      }
      sendJson(res, 404, { error: 'unknown radar route' });
    } catch (err) {
      console.warn('[nexrad-l2]', err?.message || err);
      sendJson(res, 502, { error: 'radar ingest failed' });
    }
  }

  function close() {
    if (reaper !== null) unschedule(reaper);
    reaper = null;
    release?.();
    release = null;
    for (const entry of watched.values()) entry.unwatch?.();
    watched.clear();
  }

  return { provider, assembler, snapshot, touch, close, handle };
}

/** The provider definition the registry installs. */
export function nexradLevel2Provider(options) {
  return createLevel2Ingest(options).provider;
}
