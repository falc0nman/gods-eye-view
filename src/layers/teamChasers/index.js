import * as Cesium from 'cesium';
import { createTeamChaserPicker } from './picker.js';

/**
 * Team Chasers — the chase team's live positions from the Life360 circle,
 * served by this app's own server (server/providers/life360.js), read through
 * ./source.js. The Life360 token never
 * reaches the browser; this layer only sees first name, position, fix time
 * and battery.
 *
 * Dot color follows the old Supercell placefile: green live (≤2 min), amber
 * getting stale (≤10 min), red stale.
 */

export const TEAM_CHASERS_OVERLAY_SOURCE_ID = 'team-chasers';
const OVERLAY_LIMIT = 64;
const FRESH_S = 120;
const WARN_S = 600;

export function chaserAgeColor(ageS) {
  if (Number.isFinite(ageS) && ageS <= FRESH_S) return '#00dc00';
  if (Number.isFinite(ageS) && ageS <= WARN_S) return '#ffbe00';
  return '#c83c3c';
}

export function chaserDetail(chaser, nowMs) {
  const ageS = Number.isFinite(chaser.fixMs)
    ? (nowMs - chaser.fixMs) / 1000
    : null;
  const age =
    ageS === null
      ? 'fix unknown'
      : ageS < 120
        ? `fix ${Math.max(0, Math.floor(ageS))}s ago`
        : `fix ${Math.floor(ageS / 60)}m ago`;
  return Number.isFinite(chaser.battery)
    ? `${age} · batt ${chaser.battery}%`
    : age;
}

export function createTeamChasersLayer({
  source,
  overlayHost,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Team chasers require a snapshot source');
  if (typeof overlayHost?.setEntries !== 'function')
    throw new TypeError('Team chasers require an overlay host');
  let _dataSource = null;
  let _enabled = false;
  let _chasers = [];
  let _configured = null;
  let _health = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _picker = null;

  const render = () => {
    if (!_dataSource) return;
    const nowMs = now();
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    const entries = [];
    for (const c of _chasers) {
      const ageS = c.fixMs === null ? null : (nowMs - c.fixMs) / 1000;
      const color = chaserAgeColor(ageS);
      const position = Cesium.Cartesian3.fromDegrees(c.lon, c.lat);
      _dataSource.entities.add({
        id: `team-chaser:${c.id}`,
        position,
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Always on top: a chaser behind terrain or a building still shows.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { chaserName: c.name },
      });
      entries.push({
        id: c.id,
        position,
        variant: 'card',
        title: c.name,
        details: [chaserDetail(c, nowMs)],
        accent: color,
        priority: 10_000 - Math.min(9_999, Math.floor(ageS ?? 9_999)),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 10,
        verticalOnly: true,
        placement: 'above',
      });
    }
    _dataSource.entities.resumeEvents();
    if (_enabled) {
      overlayHost.setEntries(
        TEAM_CHASERS_OVERLAY_SOURCE_ID,
        entries.slice(0, OVERLAY_LIMIT),
        {
          cohortLimit: OVERLAY_LIMIT,
          collisionCapacity: OVERLAY_LIMIT,
          moving: true,
        },
      );
    }
  };

  const layer = {
    id: 'team-chasers',
    name: 'Team Chasers',
    icon: '🚙',
    source: 'Life360 chase circle',
    updateInterval: 15_000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('team-chasers');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(TEAM_CHASERS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(TEAM_CHASERS_OVERLAY_SOURCE_ID, true);
      render();
    },

    disable() {
      _enabled = false;
      _picker?.close();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(TEAM_CHASERS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TEAM_CHASERS_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer, { signal } = {}) {
      let snapshot;
      try {
        snapshot = await source.getSnapshot({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        _lastError = /HTTP/.test(error?.message)
          ? error.message
          : 'chaser bridge unreachable';
        return _configured !== null; // keep the last positions on screen
      }
      _configured = snapshot.configured;
      _health = snapshot.health;
      _chasers = snapshot.chasers;
      // INIT with a reason (bad token, throttled) is a failure to say out
      // loud, not an endless "connecting".
      const initFailed =
        _health?.state === 'INIT' && !/^starting up/.test(_health.detail || '');
      _lastError =
        _health?.state === 'FAIL' || initFailed
          ? `Life360: ${_health.detail}`
          : null;
      _lastUpdate = now();
      render();
      return true;
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(TEAM_CHASERS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TEAM_CHASERS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _chasers = [];
    },

    /** The row's PICK CHASERS chip (shown once Life360 is set up). */
    getRowControls() {
      if (_configured !== true) return null;
      return {
        chips: [
          {
            id: 'pick',
            label: 'PICK CHASERS',
            title: 'Choose who shows on the map and in the Supercell placefile',
            params: { openPicker: true },
          },
        ],
      };
    },

    getParams() {
      return {};
    },

    /** `openPicker` is a UI action, not durable layer state. */
    setParams(params = {}) {
      if (params.openPicker === true) {
        _picker ??= createTeamChaserPicker({
          source,
          // Show the new selection now rather than at the next 15 s poll.
          onSaved: () => {
            void layer.update(null);
          },
        });
        void _picker.open();
      }
      return true;
    },

    /** Plain positions, for later "cameras near my chasers" queries. */
    getChasers() {
      return _chasers.map((c) => ({ ...c }));
    },

    getStats() {
      if (_configured === false) {
        return {
          count: 0,
          lastUpdate: _lastUpdate,
          error: null,
          status: 'idle',
          loadingLabel: 'not set up · add LIFE360_TOKEN to .env',
        };
      }
      return {
        count: _chasers.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _health?.state === 'STALE',
        ...(_health?.state === 'INIT' && !_lastError
          ? { loading: true, loadingLabel: 'connecting to Life360…' }
          : {}),
        ...(_health?.state === 'OK'
          ? { loadingLabel: `${_chasers.length} on map · Life360 OK` }
          : {}),
      };
    },
  };
  return layer;
}
