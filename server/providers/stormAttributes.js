import { defineProvider } from './common/provider.js';

/**
 * NEXRAD storm attributes from the Iowa Environmental Mesonet — hail and TVS.
 *
 * NOAA stopped publishing the Hail Index (NHI) and TVS (NTV) Level III
 * products to the open `unidata-nexrad-level3` bucket in 2022. IEM keeps
 * ingesting the NWS storm attribute table (derived from the same Level III
 * products) and serves the current cells per radar as GeoJSON:
 *
 *   https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson?radar=TLX
 *
 * Each feature is one storm cell: `nexrad`, `storm_id`, `azimuth`, `range`
 * (nm), `tvs`, `meso`, `posh` / `poh` (%), `max_size` (in), `vil`,
 * `max_dbz`, `max_dbz_height`, `top` (kft), `drct` / `sknt` (motion), `valid`.
 *
 * Route:
 *   GET /api/radar/storm-attributes?site=TLX
 *       → {site, source, validTime, cells[], hail[], tvs[]}
 *
 * A GW-80 pull provider over the radars clients are asking about (the same
 * watch-while-requested pattern as Level III), with health per radar.
 */

export const IEM_STORM_ATTRIBUTES_URL =
  'https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson';
const USER_AGENT =
  'Gods Eye View (storm attributes; github.com/falc0nman/gods-eye-view)';
const SITE_RE = /^[A-Z0-9]{3}$/;
const WATCH_TTL_MS = 6 * 60_000;
const POLL_MS = 60_000;
const CACHE_MS = 30_000;
const MAX_BYTES = 8 * 1024 * 1024;

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** `NONE`, empty and null mean "no detection". */
const detection = (value) => {
  const text = String(value ?? '').trim();
  return text && text.toUpperCase() !== 'NONE' ? text : null;
};

/**
 * One IEM feature → a storm cell. Tolerant of numbers sent as strings and of
 * absent fields; positions come from the GeoJSON point.
 */
export function normalizeStormCell(feature) {
  const p = feature?.properties ?? {};
  const [lon, lat] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const validTime = Date.parse(p.valid ?? '');
  const posh = num(p.posh);
  const poh = num(p.poh);
  const maxSizeIn = num(p.max_size);
  const tvs = detection(p.tvs);
  const drct = num(p.drct);
  const sknt = num(p.sknt);
  return {
    site: String(p.nexrad ?? '').toUpperCase() || null,
    id: String(p.storm_id ?? '').trim() || null,
    lat,
    lon,
    azimuthDeg: num(p.azimuth),
    rangeNm: num(p.range),
    validTime: Number.isFinite(validTime) ? validTime : null,
    hail: {
      // Probability of severe hail (≥ 1 in) and of any hail, percent.
      severeProbabilityPct: posh,
      probabilityPct: poh,
      maxSizeIn,
    },
    // TVS or ETVS (elevated) when detected.
    tvs,
    mesocyclone: detection(p.meso),
    vilKgM2: num(p.vil),
    maxReflectivity: {
      dbz: num(p.max_dbz),
      heightKft: num(p.max_dbz_height),
    },
    topKft: num(p.top),
    // Meteorological: the direction the cell moves FROM, knots.
    motion:
      drct !== null && sknt !== null ? { fromDeg: drct, speedKt: sknt } : null,
  };
}

/** IEM FeatureCollection → the cells of one radar, plus hail and TVS subsets. */
export function normalizeStormAttributes(geojson, site) {
  if (!Array.isArray(geojson?.features))
    throw new Error('Malformed IEM storm attributes response');
  const cells = geojson.features
    .map(normalizeStormCell)
    .filter((cell) => cell && (!cell.site || cell.site === site));
  const times = cells.map((c) => c.validTime).filter(Number.isFinite);
  return {
    site,
    source: 'Iowa Environmental Mesonet (NWS storm attribute table)',
    validTime: times.length ? Math.max(...times) : null,
    cells,
    hail: cells.filter(
      (c) =>
        (c.hail.severeProbabilityPct ?? 0) > 0 ||
        (c.hail.probabilityPct ?? 0) > 0 ||
        (c.hail.maxSizeIn ?? 0) > 0,
    ),
    tvs: cells.filter((c) => c.tvs),
  };
}

async function readJsonCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error('Upstream response too large');
  const text = await response.text();
  if (text.length > maxBytes) throw new Error('Upstream response too large');
  return JSON.parse(text);
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createStormAttributesIngest({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  url = IEM_STORM_ATTRIBUTES_URL,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
} = {}) {
  /** site → expiry */
  const watched = new Map();
  /** site → {at, promise} */
  const cache = new Map();
  let runtime = null;
  let release = null;
  let reaper = null;

  function load(site) {
    const hit = cache.get(site);
    if (hit && now() - hit.at < CACHE_MS) return hit.promise;
    const promise = (async () => {
      const res = await fetchImpl(`${url}?radar=${encodeURIComponent(site)}`, {
        headers: { Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`IEM HTTP ${res.status}`);
      return normalizeStormAttributes(
        await readJsonCapped(res, MAX_BYTES),
        site,
      );
    })();
    promise.catch(() => {
      if (cache.get(site)?.promise === promise) cache.delete(site);
    });
    cache.set(site, { at: now(), promise });
    return promise;
  }

  function reap() {
    reaper = null;
    for (const [site, expiresAt] of watched)
      if (expiresAt <= now()) watched.delete(site);
    if (!watched.size) {
      release?.();
      release = null;
      return;
    }
    reaper = schedule(reap, WATCH_TTL_MS);
    reaper?.unref?.();
  }

  function touch(site) {
    watched.set(site, now() + WATCH_TTL_MS);
    if (runtime && !release) release = runtime.acquire();
    if (reaper === null) {
      reaper = schedule(reap, WATCH_TTL_MS);
      reaper?.unref?.();
    }
  }

  // One item per radar per attribute table time, so an unchanged table is
  // not republished.
  const itemFor = (site, attributes) => ({
    key: `${site}:${attributes.validTime ?? 'none'}`,
    site,
    attributes,
  });

  const provider = defineProvider({
    id: 'storm-attributes',
    label: 'NEXRAD storm attributes (hail, TVS)',
    mode: 'pull',
    pollMs: POLL_MS,
    source: {
      name: 'Iowa Environmental Mesonet',
      url: 'https://mesonet.agron.iastate.edu/',
      license: 'IEM public data; derived from NWS NEXRAD Level III',
    },
    // The attribute table updates every volume scan (4–10 minutes).
    health: { degradedAfterMs: 10 * 60_000, staleAfterMs: 20 * 60_000 },
    async discover() {
      const items = [];
      let failure = null;
      for (const [site, expiresAt] of watched) {
        if (expiresAt <= now()) continue;
        try {
          const attributes = await load(site);
          if (attributes.validTime !== null)
            items.push(itemFor(site, attributes));
        } catch (error) {
          failure ??= error;
        }
      }
      if (!items.length && failure) throw failure;
      return items;
    },
    normalize: (item) => ({
      key: item.key,
      product: item.site,
      validTime: item.attributes.validTime,
      data: {
        site: item.site,
        cells: item.attributes.cells.length,
        hail: item.attributes.hail.length,
        tvs: item.attributes.tvs.length,
      },
      provenance: { object: `${url}?radar=${item.site}` },
    }),
    routes(server, providerRuntime) {
      runtime = providerRuntime;
      server.middlewares.use('/api/radar/storm-attributes', handle);
    },
  });

  function sendJson(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const u = new URL(req.url || '/', 'http://local');
    if (u.pathname !== '/' && u.pathname !== '') {
      sendJson(res, 404, { error: 'unknown storm attributes route' });
      return;
    }
    const site = String(u.searchParams.get('site') || '').toUpperCase();
    if (!SITE_RE.test(site)) {
      sendJson(res, 400, { error: 'site must be a 3-letter radar id' });
      return;
    }
    try {
      const attributes = await load(site);
      touch(site);
      if (attributes.validTime !== null)
        await runtime?.ingest(itemFor(site, attributes));
      sendJson(res, 200, attributes);
    } catch (error) {
      console.warn('[storm-attributes]', error?.message || error);
      sendJson(res, 502, { error: 'storm attributes unavailable' });
    }
  }

  function close() {
    if (reaper !== null) unschedule(reaper);
    reaper = null;
    release?.();
    release = null;
    watched.clear();
  }

  return { provider, touch, close, handle, watched: () => [...watched.keys()] };
}

/** The provider definition the registry installs. */
export function stormAttributesProvider(options) {
  return createStormAttributesIngest(options).provider;
}
