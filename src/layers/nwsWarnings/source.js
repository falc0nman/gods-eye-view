import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * NWS storm-based warnings — acquisition and parsing. Tornado, Severe
 * Thunderstorm and Flash Flood Warnings in force right now, from
 * api.weather.gov (keyless, CORS-open). No rendering here; see ./index.js.
 *
 * Watches are NOT included: the feed gives them county lists, not polygons.
 * One storm can appear several times in the feed (the original issuance and
 * its continuations). Warnings are keyed by their VTEC event (office,
 * phenomenon, significance, tracking number) and only the newest message per
 * event is kept, so an updated, shrunken polygon replaces the old one.
 */

export const NWS_WARNING_EVENTS = Object.freeze([
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
]);
const API_URL =
  'https://api.weather.gov/alerts/active?status=actual&event=' +
  NWS_WARNING_EVENTS.map(encodeURIComponent).join(',');
const RESPONSE_LIMIT = 8 * 1024 * 1024;

/** Conventional chaser-app colors; a tornado emergency gets its own. */
const STYLES = Object.freeze({
  'Tornado Warning': Object.freeze({ code: 'TOR', color: '#ff2020', rank: 3 }),
  'Severe Thunderstorm Warning': Object.freeze({
    code: 'SVR',
    color: '#ffd400',
    rank: 2,
  }),
  'Flash Flood Warning': Object.freeze({
    code: 'FFW',
    color: '#00e050',
    rank: 1,
  }),
});
const EMERGENCY_COLOR = '#ff30ff';

const first = (params, key) => {
  const value = params?.[key];
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/**
 * Stable per-event key from the warning's VTEC string, e.g.
 * `/O.CON.KCRP.SV.W.0077.000000T0000Z-261002T0115Z/` → `KCRP.SV.W.0077`.
 * @returns {string|null}
 */
export function vtecEventKey(vtec) {
  const match =
    /\/[OTEX]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(
      String(vtec ?? ''),
    );
  return match ? `${match[1]}.${match[2]}.${match[3]}.${match[4]}` : null;
}

/**
 * Parse `eventMotionDescription`:
 * `2026-10-02T00:20:00-00:00...storm...253DEG...23KT...28.05,-97.87 27.93,-97.79`.
 * The direction is where the storm moves FROM (meteorological convention).
 * @returns {{timeMs: number|null, fromDeg: number, speedKt: number, points: Array<{lat:number, lon:number}>}|null}
 */
export function parseStormMotion(description) {
  const parts = String(description ?? '').split('...');
  if (parts.length < 5) return null;
  const deg = /^(\d{1,3})DEG$/.exec(parts[2]);
  const kt = /^(\d{1,3})KT$/.exec(parts[3]);
  if (!deg || !kt) return null;
  const points = parts
    .slice(4)
    .join(' ')
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [lat, lon] = pair.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    })
    .filter(Boolean);
  const timeMs = Date.parse(parts[0]);
  return {
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    fromDeg: Number(deg[1]) % 360,
    speedKt: Number(kt[1]),
    points,
  };
}
function outerRings(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (geometry?.type === 'MultiPolygon')
    return (geometry.coordinates || []).map((poly) => poly?.[0]);
  return [];
}

function validRing(ring) {
  return (
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every(
      (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
  );
}

/** Threat tags for the label's detail line. */
function threatTags(event, params) {
  const tags = [];
  if (event === 'Tornado Warning') {
    const detection = first(params, 'tornadoDetection');
    if (detection)
      tags.push(detection === 'OBSERVED' ? 'OBSERVED' : 'RADAR INDICATED');
  } else if (first(params, 'tornadoDetection') === 'POSSIBLE') {
    tags.push('TORNADO POSSIBLE');
  }
  const gust = first(params, 'maxWindGust');
  if (gust && !/^0/.test(gust)) tags.push(gust.replace(/\s*MPH$/i, ' mph'));
  const hail = Number(first(params, 'maxHailSize'));
  if (Number.isFinite(hail) && hail > 0) tags.push(`${hail.toFixed(2)}" hail`);
  const damage =
    first(params, 'tornadoDamageThreat') ||
    first(params, 'thunderstormDamageThreat') ||
    first(params, 'flashFloodDamageThreat');
  if (damage === 'CATASTROPHIC')
    tags.push(event === 'Tornado Warning' ? 'TORNADO EMERGENCY' : 'EMERGENCY');
  else if (damage === 'CONSIDERABLE')
    tags.push(event === 'Tornado Warning' ? 'PDS' : 'CONSIDERABLE');
  return tags;
}

/**
 * Reduce an api.weather.gov alerts FeatureCollection to the warnings to draw:
 * supported events with polygons, not cancelled, not yet expired, newest
 * message per VTEC event. Pure — no Cesium types.
 * @param {unknown} geojson
 * @param {number} nowMs
 */
export function normalizeWarnings(geojson, nowMs) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const latest = new Map();
  for (const feature of features) {
    const p = feature?.properties || {};
    const style = STYLES[p.event];
    if (!style || p.messageType === 'Cancel') continue;
    const rings = outerRings(feature.geometry).filter(validRing);
    if (!rings.length) continue;
    const endsMs = Date.parse(p.ends || p.expires || '');
    if (Number.isFinite(endsMs) && endsMs <= nowMs) continue;
    const params = p.parameters || {};
    const key =
      vtecEventKey(first(params, 'VTEC')) || String(feature.id || p.id || '');
    if (!key) continue;
    const sentMs = Date.parse(p.sent || '') || 0;
    const prior = latest.get(key);
    if (prior && prior.sentMs >= sentMs) continue;
    const tags = threatTags(p.event, params);
    const emergency =
      tags.includes('TORNADO EMERGENCY') || tags.includes('EMERGENCY');
    const emphasized =
      emergency || tags.includes('PDS') || tags.includes('OBSERVED');
    latest.set(key, {
      key,
      id: String(feature.id || p.id || key),
      event: p.event,
      code: style.code,
      rank: style.rank * 10 + (emergency ? 100 : 0) + (emphasized ? 5 : 0),
      color: emergency ? EMERGENCY_COLOR : style.color,
      emergency,
      emphasized,
      tags,
      rings,
      sentMs,
      endsMs: Number.isFinite(endsMs) ? endsMs : null,
      office: p.senderName || null,
      headline: p.headline || null,
      areaDesc: p.areaDesc || null,
      motion: parseStormMotion(first(params, 'eventMotionDescription')),
    });
  }
  return [...latest.values()].sort(
    (a, b) => b.rank - a.rank || a.key.localeCompare(b.key),
  );
}

/** Lazy acquisition; owns only its deadline and cancellation. */
export function createNwsWarningsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  return {
    /** @returns {Promise<{warnings: ReturnType<typeof normalizeWarnings>}>} */
    async getSnapshot({ signal, nowMs = Date.now() } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('NWS request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(API_URL, {
          signal: controller.signal,
          headers: { Accept: 'application/geo+json' },
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          throw new Error(`NWS HTTP ${response.status}`);
        }
        const geojson = await readResponseJsonCapped(
          response,
          RESPONSE_LIMIT,
          controller.signal,
        );
        if (!Array.isArray(geojson?.features))
          throw new Error('Malformed NWS response');
        return { warnings: normalizeWarnings(geojson, nowMs) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
