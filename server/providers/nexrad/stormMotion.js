/**
 * Storm motion for storm-relative velocity (GW-72) — SERVER-SIDE.
 *
 * Either the user supplies one (`240/30`: moving FROM 240° at 30 kt), or
 * `auto` takes the motion the NWS forecaster put on the nearest active
 * Tornado / Severe Thunderstorm / Flash Flood Warning within radar range
 * (`eventMotionDescription`). The result always says which vector was
 * applied and where it came from, so displays can label it.
 *
 * Sharing a selected motion with the intercept tools (GW-23) belongs to the
 * shared operational state (GW-28); this module is where that state will
 * plug in.
 */

import { createNwsWarningsSource } from '../../../src/layers/nwsWarnings/source.js';
import { parseStormMotion } from './dealias.js';

const WARNINGS_TTL_MS = 2 * 60_000;
const MAX_RANGE_KM = 250;

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Where a warning's storm is: its motion point, else its polygon's centre. */
function warningPoint(warning) {
  const point = warning.motion?.points?.[0];
  if (point) return point;
  const ring = warning.rings?.[0];
  if (!ring?.length) return null;
  const sum = ring.reduce(
    (acc, [lon, lat]) => [acc[0] + lat, acc[1] + lon],
    [0, 0],
  );
  return { lat: sum[0] / ring.length, lon: sum[1] / ring.length };
}

export const describeMotion = ({ fromDeg, speedKt }) =>
  `${String(Math.round(fromDeg)).padStart(3, '0')}° / ${Math.round(speedKt)} kt`;

/** api.weather.gov refuses non-browser requests without a User-Agent. */
export const NWS_USER_AGENT =
  'Gods Eye View (storm-relative velocity; github.com/falc0nman/gods-eye-view)';

export function createStormMotionSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  warnings = createNwsWarningsSource({
    fetchImpl: (url, init = {}) =>
      fetchImpl(url, {
        ...init,
        headers: { ...init.headers, 'User-Agent': NWS_USER_AGENT },
      }),
  }),
} = {}) {
  let cached = null; // {at, promise}

  function activeWarnings() {
    if (cached && now() - cached.at < WARNINGS_TTL_MS) return cached.promise;
    const promise = warnings
      .getSnapshot({ nowMs: now() })
      .then((s) => s.warnings);
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
    cached = { at: now(), promise };
    return promise;
  }

  /**
   * @param {string|null} request - `DDD/SS`, `auto`, or empty for none.
   * @param {{lat: number, lon: number}|null} radar
   * @returns {Promise<{motion: object|null, error?: string}>}
   */
  async function resolve(request, radar) {
    const text = String(request ?? '').trim();
    if (!text) return { motion: null };
    if (text.toLowerCase() !== 'auto') {
      const motion = parseStormMotion(text);
      if (!motion)
        return {
          motion: null,
          error: 'motion must be DDD/SS (from degrees / knots) or auto',
        };
      return {
        motion: {
          ...motion,
          source: 'user',
          label: `${describeMotion(motion)} (user)`,
        },
      };
    }
    if (!radar) return { motion: null, error: 'radar position not known yet' };
    let list;
    try {
      list = await activeWarnings();
    } catch (error) {
      return {
        motion: null,
        error: `NWS warnings unavailable: ${error?.message || error}`,
      };
    }
    let best = null;
    for (const warning of list) {
      if (!warning.motion) continue;
      const point = warningPoint(warning);
      if (!point) continue;
      const km = distanceKm(radar, point);
      if (km <= MAX_RANGE_KM && (!best || km < best.km)) best = { warning, km };
    }
    if (!best)
      return {
        motion: null,
        error: `no NWS warning with a storm motion within ${MAX_RANGE_KM} km`,
      };
    const { fromDeg, speedKt, timeMs } = best.warning.motion;
    return {
      motion: {
        fromDeg,
        speedKt,
        source: 'nws-warning',
        label: `${describeMotion({ fromDeg, speedKt })} (${best.warning.code} ${best.warning.key})`,
        warning: {
          key: best.warning.key,
          event: best.warning.event,
          office: best.warning.office,
          distanceKm: Math.round(best.km),
          motionTimeMs: timeMs,
        },
      },
    };
  }

  return { resolve };
}
