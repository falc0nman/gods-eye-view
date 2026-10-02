import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * NWS storm-based warnings — Tornado, Severe Thunderstorm and Flash Flood
 * Warnings in force right now, from api.weather.gov (keyless, CORS-open).
 *
 * Each warning is its polygon (translucent ground fill + ground-clamped
 * outline) plus one ambient label at the storm's reported position, carrying
 * the threat tags and the storm motion parsed from the warning's
 * TIME...MOT...LOC line ("→ ENE 26 mph"), which is what a chaser needs at a
 * glance.
 *
 * Geometry is STATIC and rebuilt only when the warning set actually changes
 * (see the earthquake layer's header for what per-frame ground geometry costs).
 * Watches are NOT drawn: the feed gives them county lists, not polygons.
 *
 * One storm can appear several times in the feed (the original issuance and
 * its continuations). Warnings are keyed by their VTEC event (office,
 * phenomenon, significance, tracking number) and only the newest message per
 * event is drawn, so an updated, shrunken polygon replaces the old one.
 */

export const NWS_WARNING_EVENTS = Object.freeze([
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
]);
const API_URL = 'https://api.weather.gov/alerts/active?status=actual&event='
  + NWS_WARNING_EVENTS.map(encodeURIComponent).join(',');

export const NWS_WARNINGS_OVERLAY_SOURCE_ID = 'nws-warnings';
export const NWS_WARNINGS_OVERLAY_COHORT_LIMIT = 96;
const NWS_WARNINGS_OVERLAY_COLLISION_CAPACITY = 48;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** Conventional chaser-app colors; a tornado emergency gets its own. */
const STYLES = Object.freeze({
  'Tornado Warning': Object.freeze({ code: 'TOR', color: '#ff2020', rank: 3 }),
  'Severe Thunderstorm Warning': Object.freeze({ code: 'SVR', color: '#ffd400', rank: 2 }),
  'Flash Flood Warning': Object.freeze({ code: 'FFW', color: '#00e050', rank: 1 }),
});
const EMERGENCY_COLOR = '#ff30ff';
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const KT_TO_MPH = 1.15078;

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
  const match = /\/[OTEX]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(String(vtec ?? ''));
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
  const points = parts.slice(4).join(' ').trim().split(/\s+/).map((pair) => {
    const [lat, lon] = pair.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }).filter(Boolean);
  const timeMs = Date.parse(parts[0]);
  return {
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    fromDeg: Number(deg[1]) % 360,
    speedKt: Number(kt[1]),
    points,
  };
}

/** `→ ENE 26 mph`, or `stationary`. */
export function formatStormMotion(motion) {
  if (!motion) return null;
  if (motion.speedKt === 0) return 'stationary';
  const towardDeg = (motion.fromDeg + 180) % 360;
  const dir = COMPASS[Math.round(towardDeg / 22.5) % 16];
  return `→ ${dir} ${Math.round(motion.speedKt * KT_TO_MPH)} mph`;
}

function outerRings(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (geometry?.type === 'MultiPolygon') return (geometry.coordinates || []).map((poly) => poly?.[0]);
  return [];
}

function validRing(ring) {
  return Array.isArray(ring) && ring.length >= 4
    && ring.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** Threat tags for the label's detail line. */
function threatTags(event, params) {
  const tags = [];
  if (event === 'Tornado Warning') {
    const detection = first(params, 'tornadoDetection');
    if (detection) tags.push(detection === 'OBSERVED' ? 'OBSERVED' : 'RADAR INDICATED');
  } else if (first(params, 'tornadoDetection') === 'POSSIBLE') {
    tags.push('TORNADO POSSIBLE');
  }
  const gust = first(params, 'maxWindGust');
  if (gust && !/^0/.test(gust)) tags.push(gust.replace(/\s*MPH$/i, ' mph'));
  const hail = Number(first(params, 'maxHailSize'));
  if (Number.isFinite(hail) && hail > 0) tags.push(`${hail.toFixed(2)}" hail`);
  const damage = first(params, 'tornadoDamageThreat') || first(params, 'thunderstormDamageThreat')
    || first(params, 'flashFloodDamageThreat');
  if (damage === 'CATASTROPHIC') tags.push(event === 'Tornado Warning' ? 'TORNADO EMERGENCY' : 'EMERGENCY');
  else if (damage === 'CONSIDERABLE') tags.push(event === 'Tornado Warning' ? 'PDS' : 'CONSIDERABLE');
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
    const key = vtecEventKey(first(params, 'VTEC')) || String(feature.id || p.id || '');
    if (!key) continue;
    const sentMs = Date.parse(p.sent || '') || 0;
    const prior = latest.get(key);
    if (prior && prior.sentMs >= sentMs) continue;
    const tags = threatTags(p.event, params);
    const emergency = tags.includes('TORNADO EMERGENCY') || tags.includes('EMERGENCY');
    const emphasized = emergency || tags.includes('PDS') || tags.includes('OBSERVED');
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
  return [...latest.values()].sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key));
}

/** Where the label sits: the storm's reported position, else the polygon's vertex mean. */
export function warningAnchor(warning) {
  const point = warning.motion?.points?.[0];
  if (point) return { lat: point.lat, lon: point.lon };
  const ring = warning.rings[0];
  const pts = ring.slice(0, -1);
  return {
    lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
  };
}

/** `until 20:15Z`. */
function formatEnds(endsMs) {
  return Number.isFinite(endsMs) ? `until ${new Date(endsMs).toISOString().slice(11, 16)}Z` : null;
}

export function warningLabel(warning) {
  const detail = [...warning.tags, formatStormMotion(warning.motion), formatEnds(warning.endsMs)]
    .filter(Boolean).join(' · ');
  return { title: warning.code, details: detail ? [detail] : [] };
}

/** Change detector: rebuild geometry only when this differs. */
function signature(warnings) {
  return warnings.map((w) => `${w.key}@${w.sentMs}`).join('|');
}

export function createNwsWarningsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let _dataSource = null;
  let _enabled = false;
  let _warnings = [];
  let _signature = '';
  let _lastUpdate = null;
  let _lastError = null;

  const publishLabels = () => {
    if (!_enabled) return;
    overlayHost.setEntries(
      NWS_WARNINGS_OVERLAY_SOURCE_ID,
      _warnings.slice(0, NWS_WARNINGS_OVERLAY_COHORT_LIMIT).map((w) => {
        const anchor = warningAnchor(w);
        const { title, details } = warningLabel(w);
        return {
          id: w.key,
          position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
          // 'card', not 'label': the label variant draws only the title.
          variant: 'card',
          title,
          details,
          accent: w.color,
          priority: w.rank * 100,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
        };
      }),
      {
        cohortLimit: NWS_WARNINGS_OVERLAY_COHORT_LIMIT,
        collisionCapacity: NWS_WARNINGS_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  };

  const rebuildGeometry = () => {
    if (!_dataSource) return;
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const w of _warnings) {
      const color = Cesium.Color.fromCssColorString(w.color);
      w.rings.forEach((ring, i) => {
        const positions = Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]));
        _dataSource.entities.add({
          id: `nws-warning:${w.key}:${i}`,
          polygon: {
            hierarchy: positions,
            material: color.withAlpha(w.emergency ? 0.3 : 0.18),
          },
          polyline: {
            positions,
            clampToGround: true,
            width: w.emphasized ? 4 : 3,
            material: color.withAlpha(0.95),
          },
          properties: { warningKey: w.key, event: w.event, headline: w.headline, areaDesc: w.areaDesc },
        });
      });
    }
    _dataSource.entities.resumeEvents();
  };

  const layer = {
    id: 'nws-warnings',
    name: 'NWS Storm Warnings',
    icon: '⚠️',
    source: 'NWS api.weather.gov',
    updateInterval: 60_000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('nws-warnings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _warnings = [];
      _signature = '';
      _lastUpdate = null;
      _lastError = null;
      overlayHost.setVisible(NWS_WARNINGS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(NWS_WARNINGS_OVERLAY_SOURCE_ID, true);
      publishLabels();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(NWS_WARNINGS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NWS_WARNINGS_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer, { signal } = {}) {
      let geojson;
      try {
        const response = await fetchImpl(API_URL, { signal, headers: { Accept: 'application/geo+json' } });
        if (!response.ok) {
          _lastError = `NWS HTTP ${response.status}`;
          return false;
        }
        geojson = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        _lastError = 'NWS network error';
        return false;
      }
      if (!Array.isArray(geojson?.features)) {
        _lastError = 'Malformed NWS response';
        return false;
      }
      _warnings = normalizeWarnings(geojson, now());
      const next = signature(_warnings);
      if (next !== _signature) {
        _signature = next;
        rebuildGeometry();
        publishLabels();
      }
      _lastUpdate = now();
      _lastError = null;
      return true;
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(NWS_WARNINGS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NWS_WARNINGS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _warnings = [];
      _signature = '';
    },

    /** Warnings in force, plain JSON (for later "cameras near this storm" queries). */
    getWarnings() {
      return _warnings.map((w) => ({
        key: w.key,
        event: w.event,
        code: w.code,
        tags: [...w.tags],
        emergency: w.emergency,
        anchor: warningAnchor(w),
        rings: w.rings.map((ring) => ring.map(([lon, lat]) => [lon, lat])),
        endsMs: w.endsMs,
        office: w.office,
        areaDesc: w.areaDesc,
        motion: w.motion ? { fromDeg: w.motion.fromDeg, speedKt: w.motion.speedKt } : null,
      }));
    },

    getStats() {
      const counts = { TOR: 0, SVR: 0, FFW: 0 };
      for (const w of _warnings) counts[w.code] += 1;
      return {
        count: _warnings.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        ...(_lastUpdate && !_warnings.length ? { status: 'empty' } : {}),
        loadingLabel: _lastUpdate
          ? (_warnings.length ? `${counts.TOR} TOR · ${counts.SVR} SVR · ${counts.FFW} FFW` : 'no warnings in force')
          : '',
      };
    },
  };
  return layer;
}

const nwsWarningsLayer = createNwsWarningsLayer();

export default nwsWarningsLayer;
