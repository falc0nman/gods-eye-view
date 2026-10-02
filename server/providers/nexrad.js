import zlib from 'node:zlib';
import Bunzip from 'seek-bzip';
import { beamHeightFt, decodeLevel3, valueAt } from './nexrad/level3.js';
import { encodePng, renderLevel3 } from './nexrad/render.js';

/**
 * NEXRAD Level III — decoded and rendered here, so browsers only ever receive
 * a finished image. Source: NOAA's public `unidata-nexrad-level3` bucket
 * (AWS Open Data, keyless, ~every 2–5 min per radar). See ./nexrad/level3.js
 * and ./nexrad/render.js.
 *
 * Routes:
 *   GET /api/radar/l3/scan?site=TLX&product=N0G
 *       → {key, product, scanMs, elevationDeg, bounds, site, image}
 *   GET /api/radar/l3/image/<key>.png   (immutable per scan key)
 *   GET /api/radar/l3/value?key=<key>&lat=&lon=
 *       → {value, inRange, rangeKm, azimuthDeg, beamHeightFt} — cursor readout
 *
 * Each scan is fetched from NOAA once and rendered once; the newest-scan
 * lookup is cached 30 s, and the last 40 decoded scans are kept in memory.
 */

const BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
export const LEVEL3_PRODUCTS = Object.freeze(
  new Set([
    'N0B',
    'N1B',
    'N2B',
    'N3B',
    'N0G',
    'N1G',
    'N0S',
    'N0C',
    'N1C',
    'N2C',
    'N3C',
    'N0X',
    'N1X',
    'N2X',
    'N3X',
    'N0K',
    'N1K',
    'N2K',
    'N3K',
    'N0H',
    'N1H',
    'N2H',
    'N3H',
    'DVL',
    'EET',
  ]),
);
export const LEVEL3_KEY_RE =
  /^[A-Z0-9]{3}_[A-Z0-9]{3}_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/;
const LIST_TTL_MS = 30_000;
const MAX_SCANS = 40;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function readBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error('Upstream response too large');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes)
    throw new Error('Upstream response too large');
  return new Uint8Array(buffer);
}

/**
 * Scan lookup, decode and render, with caches. Exported for tests.
 * @param {{fetchImpl?: Function, now?: () => number}} [options]
 */
export function createLevel3Service({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {at: number, key: string|null}>} */
  const latest = new Map();
  /** @type {Map<string, Promise<{png: Uint8Array, product: object, meta: object}>>} insertion-ordered LRU */
  const scans = new Map();

  const dayPrefix = (ms) =>
    new Date(ms).toISOString().slice(0, 10).replace(/-/g, '_');
  async function listKeys(prefix) {
    const res = await fetchImpl(
      `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}`,
      {
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`NOAA list HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((m) => m[1])
      .filter((k) => LEVEL3_KEY_RE.test(k));
  }

  async function latestKey(site, product) {
    const id = `${site}_${product}`;
    const cached = latest.get(id);
    if (cached && now() - cached.at < LIST_TTL_MS) return cached.key;
    // Today's scans; just after 00Z, yesterday's are the newest.
    let keys = await listKeys(`${id}_${dayPrefix(now())}`);
    if (!keys.length)
      keys = await listKeys(`${id}_${dayPrefix(now() - 86_400_000)}`);
    const key = keys.sort().at(-1) ?? null;
    latest.set(id, { at: now(), key });
    return key;
  }

  function scan(key) {
    if (scans.has(key)) {
      const hit = scans.get(key);
      scans.delete(key);
      scans.set(key, hit); // refresh LRU position
      return hit;
    }
    const work = (async () => {
      const res = await fetchImpl(`${BUCKET}/${key}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`NOAA file HTTP ${res.status}`);
      const bytes = await readBytesCapped(res, MAX_FILE_BYTES);
      const product = decodeLevel3(bytes, {
        bunzip: (data) => Bunzip.decode(Buffer.from(data)),
      });
      const image = renderLevel3(product);
      const png = encodePng(image, {
        deflate: (data) => zlib.deflateSync(data, { level: 6 }),
        crc32: zlib.crc32,
      });
      return {
        png,
        // Kept for the cursor readout (/value): the decoded radials, not just pixels.
        product,
        meta: {
          key,
          product: key.slice(4, 7),
          scanMs: product.scanMs,
          elevationDeg: product.elevationDeg,
          bounds: image.bounds,
          site: product.site,
          image: `/api/radar/l3/image/${key}.png`,
        },
      };
    })();
    // A failed scan must not stay cached.
    work.catch(() => scans.delete(key));
    scans.set(key, work);
    while (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value);
    return work;
  }

  return { latestKey, scan };
}

/** @returns {import('vite').Plugin} */
export function nexradLevel3Proxy({ service = createLevel3Service() } = {}) {
  const sendJson = (res, status, obj) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  };
  const install = (server) => {
    server.middlewares.use('/api/radar/l3', async (req, res) => {
      const url = new URL(req.url || '/', 'http://local');
      try {
        if (url.pathname === '/scan') {
          const site = String(url.searchParams.get('site') || '').toUpperCase();
          const product = String(
            url.searchParams.get('product') || '',
          ).toUpperCase();
          if (!/^[A-Z0-9]{3}$/.test(site) || !LEVEL3_PRODUCTS.has(product)) {
            sendJson(res, 400, {
              error:
                'site must be a 3-letter radar id and product a supported Level III code',
            });
            return;
          }
          const key = await service.latestKey(site, product);
          if (!key) {
            sendJson(res, 404, {
              error: `${product} is not available from this radar right now`,
            });
            return;
          }
          sendJson(res, 200, (await service.scan(key)).meta);
          return;
        }
        if (url.pathname === '/value') {
          const key = String(url.searchParams.get('key') || '');
          const lat = Number(url.searchParams.get('lat'));
          const lon = Number(url.searchParams.get('lon'));
          if (
            !LEVEL3_KEY_RE.test(key) ||
            !LEVEL3_PRODUCTS.has(key.slice(4, 7)) ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            Math.abs(lat) > 90 ||
            Math.abs(lon) > 180
          ) {
            sendJson(res, 400, { error: 'expected key, lat and lon' });
            return;
          }
          const { product } = await service.scan(key);
          const hit = valueAt(product, lat, lon);
          sendJson(res, 200, {
            value: hit.value,
            inRange: hit.inRange,
            rangeKm: Math.round(hit.rangeKm * 10) / 10,
            azimuthDeg: Math.round(hit.azimuthDeg),
            beamHeightFt:
              hit.inRange && Number.isFinite(product.elevationDeg)
                ? Math.round(
                    beamHeightFt(
                      hit.rangeKm,
                      product.elevationDeg,
                      product.site.heightFt,
                    ) / 100,
                  ) * 100
                : null,
          });
          return;
        }
        const image = /^\/image\/([A-Z0-9_]+)\.png$/.exec(url.pathname);
        if (
          image &&
          LEVEL3_KEY_RE.test(image[1]) &&
          LEVEL3_PRODUCTS.has(image[1].slice(4, 7))
        ) {
          const { png } = await service.scan(image[1]);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400, immutable',
          });
          res.end(png);
          return;
        }
        sendJson(res, 404, { error: 'unknown radar route' });
      } catch (err) {
        console.warn('[nexrad-l3]', err?.message || err);
        sendJson(res, 502, { error: 'radar decode failed' });
      }
    });
  };
  return {
    name: 'nexrad-level3',
    configureServer: install,
    configurePreviewServer: install,
  };
}
