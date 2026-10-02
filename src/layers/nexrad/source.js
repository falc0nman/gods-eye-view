import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * Single-radar NEXRAD acquisition. Radar sites come from the Iowa
 * Environmental Mesonet's NEXRAD network list (keyless, CORS-open); scans and
 * point values come from this app's server, which decodes NOAA Level III
 * files (server/providers/nexrad.js). No rendering here.
 */

const SITES_URL =
  'https://mesonet.agron.iastate.edu/geojson/network/NEXRAD.geojson';
const SITES_LIMIT = 1024 * 1024;
const SCAN_LIMIT = 16 * 1024;
/** Single-radar products reach ~460 km from the radar. */
export const SITE_RANGE_KM = 460;

/** ICAO for display: TLX → KTLX, Alaska/Hawaii/Guam → P…, Puerto Rico → T…. */
export function radarIcao(site) {
  const prefix = ['AK', 'HI', 'GU'].includes(site.state)
    ? 'P'
    : site.state === 'PR'
      ? 'T'
      : 'K';
  return `${prefix}${site.id}`;
}

/**
 * IEM's NEXRAD network GeoJSON → online radar sites.
 * @returns {Array<{id: string, name: string, state: string|null, lat: number, lon: number}>}
 */
export function parseRadarSites(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  return features
    .map((f) => {
      const [lon, lat] = f?.geometry?.coordinates || [];
      const id = String(f?.properties?.sid || f?.id || '');
      return {
        id,
        name: String(f?.properties?.sname || id).slice(0, 64),
        state:
          typeof f?.properties?.state === 'string' ? f.properties.state : null,
        lat: Number(lat),
        lon: Number(lon),
        online: f?.properties?.online !== false,
      };
    })
    .filter(
      (s) =>
        s.online &&
        /^[A-Z0-9]{3}$/.test(s.id) &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lon),
    )
    .map(({ online, ...site }) => site);
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The radar nearest a point, or null when none is within range. */
export function nearestRadarSite(sites, lat, lon, maxKm = SITE_RANGE_KM) {
  let best = null;
  let bestKm = Infinity;
  for (const site of sites) {
    const km = distanceKm(lat, lon, site.lat, site.lon);
    if (km < bestKm) {
      best = site;
      bestKm = km;
    }
  }
  return bestKm <= maxKm ? best : null;
}

/** Validate the server's scan metadata before it becomes an imagery request. */
export function validateScan(value) {
  const b = value?.bounds;
  if (
    typeof value?.key !== 'string' ||
    !/^[A-Z0-9]{3}_[A-Z0-9]{3}_\d{4}(?:_\d{2}){5}$/.test(value.key) ||
    value.image !== `/api/radar/l3/image?key=${value.key}` ||
    !b ||
    !['west', 'south', 'east', 'north'].every((k) => Number.isFinite(b[k])) ||
    b.west >= b.east ||
    b.south >= b.north
  )
    throw new Error('Malformed radar scan');
  return {
    key: value.key,
    image: value.image,
    bounds: { west: b.west, south: b.south, east: b.east, north: b.north },
    scanMs: Number.isFinite(value.scanMs) ? value.scanMs : null,
    elevationDeg: Number.isFinite(value.elevationDeg)
      ? value.elevationDeg
      : null,
  };
}

/** Lazy acquisition; owns only request deadlines and cancellation. */
export function createNexradSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  async function request(url, limit, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Radar request timed out')),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const payload = await readResponseJsonCapped(
        response,
        limit,
        controller.signal,
      ).catch(() => null);
      if (!response.ok)
        throw new Error(payload?.error || `Radar HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async getSites({ signal } = {}) {
      return parseRadarSites(await request(SITES_URL, SITES_LIMIT, signal));
    },
    async getScan(site, code, { signal } = {}) {
      if (!/^[A-Z0-9]{3}$/.test(site) || !/^[A-Z0-9]{3}$/.test(code))
        throw new Error('Invalid radar request');
      return validateScan(
        await request(
          `/api/radar/l3/scan?site=${site}&product=${code}`,
          SCAN_LIMIT,
          signal,
        ),
      );
    },
    async getValue(key, lat, lon, { signal } = {}) {
      const url = `/api/radar/l3/value?key=${encodeURIComponent(key)}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
      return request(url, SCAN_LIMIT, signal);
    },
  };
}
