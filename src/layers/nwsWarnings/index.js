import * as Cesium from 'cesium';

/**
 * NWS storm warnings — drawing. Each warning is its polygon (translucent
 * ground fill + ground-clamped outline) plus one ambient label at the storm's
 * reported position, carrying the threat tags and the storm motion parsed from
 * the warning's TIME...MOT...LOC line ("→ ENE 26 mph"), which is what a chaser
 * needs at a glance. Parsing lives in ./source.js.
 *
 * Geometry is STATIC and rebuilt only when the warning set actually changes
 * (see the earthquake layer's header for what per-frame ground geometry costs).
 */

export const NWS_WARNINGS_OVERLAY_SOURCE_ID = 'nws-warnings';
export const NWS_WARNINGS_OVERLAY_COHORT_LIMIT = 96;
const NWS_WARNINGS_OVERLAY_COLLISION_CAPACITY = 48;
const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
const KT_TO_MPH = 1.15078;

/** `→ ENE 26 mph`, or `stationary`. */
export function formatStormMotion(motion) {
  if (!motion) return null;
  if (motion.speedKt === 0) return 'stationary';
  const towardDeg = (motion.fromDeg + 180) % 360;
  const dir = COMPASS[Math.round(towardDeg / 22.5) % 16];
  return `→ ${dir} ${Math.round(motion.speedKt * KT_TO_MPH)} mph`;
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
  return Number.isFinite(endsMs)
    ? `until ${new Date(endsMs).toISOString().slice(11, 16)}Z`
    : null;
}

export function warningLabel(warning) {
  const detail = [
    ...warning.tags,
    formatStormMotion(warning.motion),
    formatEnds(warning.endsMs),
  ]
    .filter(Boolean)
    .join(' · ');
  return { title: warning.code, details: detail ? [detail] : [] };
}

/** Change detector: rebuild geometry only when this differs. */
function signature(warnings) {
  return warnings.map((w) => `${w.key}@${w.sentMs}`).join('|');
}

export function createNwsWarningsLayer({
  source,
  overlayHost,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('NWS warnings require a snapshot source');
  if (typeof overlayHost?.setEntries !== 'function')
    throw new TypeError('NWS warnings require an overlay host');
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
        const positions = Cesium.Cartesian3.fromDegreesArray(
          ring.flatMap(([lon, lat]) => [lon, lat]),
        );
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
          properties: {
            warningKey: w.key,
            event: w.event,
            headline: w.headline,
            areaDesc: w.areaDesc,
          },
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
      let snapshot;
      try {
        snapshot = await source.getSnapshot({ signal, nowMs: now() });
      } catch (error) {
        if (signal?.aborted) throw error;
        _lastError = /^(NWS HTTP|Malformed)/.test(error?.message)
          ? error.message
          : 'NWS network error';
        return false;
      }
      _warnings = snapshot.warnings;
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
        motion: w.motion
          ? { fromDeg: w.motion.fromDeg, speedKt: w.motion.speedKt }
          : null,
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
          ? _warnings.length
            ? `${counts.TOR} TOR · ${counts.SVR} SVR · ${counts.FFW} FFW`
            : 'no warnings in force'
          : '',
      };
    },
  };
  return layer;
}
