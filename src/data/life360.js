/**
 * Life360 chase-circle bridge — SERVER-SIDE ONLY (imported by vite.config.js;
 * never by browser code, and it holds the Life360 token).
 *
 * Port of the team's standalone `life360_placefile.py`, so one process serves
 * both consumers:
 *   GET /api/chasers  → JSON positions for the in-app Team Chasers layer
 *   GET /chasers.txt  → the same GRLevelX placefile Supercell Wx already reads
 *
 * Behavior kept from the Python bridge: circle ids cached 10 min (the
 * /circles endpoint throttles hard, so a failed refresh keeps the old ids);
 * member snapshots spaced ≥12 s apart no matter how many clients poll;
 * the last good snapshot is served through upstream errors; OK / STALE /
 * FAIL / INIT health; green / amber / red by fix age; CHASER_ALLOWLIST by
 * first name. The interactive start-up roster picker became the in-app
 * picker (Team Chasers row → PICK CHASERS): its saved selection, by member
 * id, wins over CHASER_ALLOWLIST; an empty selection means everyone.
 *
 * PRIVACY: the JSON route sends first name, position, fix time and battery
 * only — no last names, addresses or account ids beyond an opaque member id.
 */

export const LIFE360_API = 'https://api.life360.com/v3';
export const PLACEFILE_REFRESH_SECONDS = 15;
const UPSTREAM_MIN_INTERVAL_MS = 12_000;
const CIRCLE_IDS_TTL_MS = 600_000;
const FRESH_S = 120;
const WARN_S = 600;
// Life360 sits behind Cloudflare, which rejects default HTTP-client agents.
const UA = 'com.life360.android.safetymapd/KOKO/24.0.0 android/13';

/** Parse `CHASER_ALLOWLIST="RJ,Dana,Sam"` into lower-case first names. */
export function parseAllowlist(value) {
  return new Set(String(value ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));
}

/**
 * Who shows. A saved picker selection ({ids}) wins over the env allowlist;
 * an empty id list means everyone, exactly as the Python picker's blank answer.
 * @returns {(member: {id: string, name: string}) => boolean}
 */
export function visibilityFilter({ selection = null, allowlist = new Set() } = {}) {
  if (selection && Array.isArray(selection.ids)) {
    const ids = new Set(selection.ids);
    return (m) => ids.size === 0 || ids.has(m.id);
  }
  return (m) => allowlist.size === 0 || allowlist.has(m.name.toLowerCase());
}

/** `Dana P.` — enough to tell two Danas apart without a full surname. */
function rosterLabel(m) {
  const first = String(m?.firstName || '?').trim() || '?';
  const lastInitial = String(m?.lastName || '').trim().charAt(0);
  return lastInitial ? `${first} ${lastInitial.toUpperCase()}.` : first;
}

/**
 * The picker's roster: every circle member, whether they have a fix, and
 * whether they currently show.
 * @returns {{mode: 'picker'|'allowlist'|'everyone', roster: Array<{id: string, label: string, hasFix: boolean, shown: boolean}>}}
 */
export function chaserRoster(members, { selection = null, allowlist = new Set() } = {}) {
  const shows = visibilityFilter({ selection, allowlist });
  const roster = (Array.isArray(members) ? members : []).filter((m) => m?.id != null).map((m) => {
    const id = String(m.id);
    const name = String(m.firstName || '?').trim() || '?';
    const loc = m.location || {};
    return {
      id,
      label: rosterLabel(m),
      hasFix: loc.latitude != null && loc.latitude !== '' && loc.longitude != null && loc.longitude !== '',
      shown: shows({ id, name }),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const mode = selection ? 'picker' : allowlist.size ? 'allowlist' : 'everyone';
  return { mode, roster };
}

/**
 * Validate a picker save body `{ids: [...]}` against the known roster.
 * Unknown ids are dropped (a member who left the circle); a malformed body
 * is refused outright.
 * @returns {{ids: string[]}|null}
 */
export function normalizeSelection(body, knownIds) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.ids) || body.ids.length > 500) return null;
  if (!body.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) return null;
  const known = new Set(knownIds);
  return { ids: [...new Set(body.ids)].filter((id) => known.has(id)) };
}

/** green live / amber getting stale / red stale, as [r, g, b]. */
export function colorForAge(ageS) {
  if (ageS <= FRESH_S) return [0, 220, 0];
  if (ageS <= WARN_S) return [255, 190, 0];
  return [200, 60, 60];
}

export function formatFixAge(ageS) {
  if (!Number.isFinite(ageS)) return 'unknown';
  return ageS < 120 ? `${Math.floor(ageS)}s ago` : `${Math.floor(ageS / 60)}m ago`;
}

/**
 * Members → positions to show: allowlisted, with a usable fix.
 * @returns {Array<{id: string, name: string, lat: number, lon: number,
 *   fixMs: number|null, ageS: number|null, battery: number|null, address: string|null}>}
 */
export function chaserPositions(members, { allowlist = new Set(), selection = null, nowMs = Date.now() } = {}) {
  const shows = visibilityFilter({ selection, allowlist });
  const out = [];
  for (const m of Array.isArray(members) ? members : []) {
    const name = String(m?.firstName || '?').trim() || '?';
    if (!shows({ id: String(m?.id ?? name), name })) continue;
    const loc = m?.location || {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (loc.latitude == null || loc.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ts = Number.parseInt(loc.timestamp, 10);
    const fixMs = Number.isFinite(ts) ? ts * 1000 : null;
    const battery = Number.parseFloat(loc.battery);
    out.push({
      id: String(m?.id ?? name),
      name,
      lat,
      lon,
      fixMs,
      ageS: fixMs === null ? null : (nowMs - fixMs) / 1000,
      battery: Number.isFinite(battery) ? Math.round(battery) : null,
      // Placefile hover only (as before); never sent by the JSON route.
      address: String(loc.name || loc.address1 || '').replace(/"/g, "'") || null,
    });
  }
  return out;
}

function markerBlock(p) {
  const [r, g, b] = colorForAge(p.ageS ?? 1e9);
  const hover = [
    `${p.name} | fix ${formatFixAge(p.ageS)}`,
    p.battery !== null ? `batt ${p.battery}%` : null,
    p.address,
  ].filter(Boolean).join(' | ');
  // Inner coords are PIXEL OFFSETS from (lat, lon): constant-size diamond.
  return `Object: ${p.lat.toFixed(6)},${p.lon.toFixed(6)}\n`
    + 'Threshold: 999\n'
    + `Color: ${r} ${g} ${b}\n`
    + 'Triangles:\n 0,9\n 9,0\n 0,-9\n 0,9\n 0,-9\n -9,0\n'
    + 'End:\n'
    + 'Color: 255 255 255\n'
    + `Text: 11,0,1,"${p.name.replace(/"/g, "'")}","${hover}"\n`
    + 'End:\n';
}

function statusBlock(lat, lon, health, nowMs) {
  const [r, g, b] = { OK: [0, 220, 0], STALE: [255, 190, 0], FAIL: [255, 40, 40], INIT: [180, 180, 180] }[health.state];
  const stamp = `${new Date(nowMs).toISOString().slice(11, 19)}Z`;
  const text = `L360 ${health.state}  ${stamp}  -  ${health.detail}`.replace(/"/g, "'");
  // 150 px above the radar centre so it isn't sitting on the storm.
  return `Object: ${lat.toFixed(6)},${lon.toFixed(6)}\nThreshold: 999\nColor: ${r} ${g} ${b}\nText: 0,150,1,"${text}"\nEnd:\n`;
}

/** The Supercell Wx placefile, byte-for-byte in the Python bridge's format. */
export function buildChaserPlacefile(positions, { health, lat = null, lon = null, nowMs = Date.now() }) {
  const lines = [
    '; Life360 chaser positions -> Supercell Wx',
    'Title: Chasers (Life360)',
    `RefreshSeconds: ${PLACEFILE_REFRESH_SECONDS}`,
    'Font: 1, 12, 1, "Arial"',
    'Threshold: 999',
    '',
  ];
  if (Number.isFinite(lat) && Number.isFinite(lon)) lines.push(statusBlock(lat, lon, health, nowMs));
  for (const p of positions) lines.push(markerBlock(p));
  return `${lines.join('\n')}\n`;
}

/**
 * Throttled, cached Life360 client.
 * @param {{token: string, circleFilter?: string|null, fetchImpl?: Function, now?: () => number, log?: Function}} options
 */
export function createLife360Client({
  token,
  circleFilter = null,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  log = () => {},
}) {
  let circleIds = [];
  let circleIdsAt = 0;
  let members = [];
  let membersAt = 0;
  let lastOkAt = 0;
  let lastError = null;
  let inflight = null;

  async function get(path) {
    const response = await fetchImpl(`${LIFE360_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 403 || response.status === 429) throw new Error(`throttled ${response.status} on ${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} on ${path}`);
    return response.json();
  }

  async function refreshCircleIds() {
    if (circleIds.length && now() - circleIdsAt < CIRCLE_IDS_TTL_MS) return;
    try {
      const data = await get('/circles');
      let ids = (data?.circles || []).map((c) => c.id).filter(Boolean);
      if (circleFilter) ids = ids.filter((id) => id === circleFilter);
      if (ids.length) {
        circleIds = ids;
        circleIdsAt = now();
      }
    } catch (error) {
      log(`circle list refresh failed (keeping cache): ${error.message}`);
    }
  }

  async function pull() {
    await refreshCircleIds();
    if (!circleIds.length) {
      lastError = 'no circles available yet (token or throttle issue)';
      return;
    }
    const pulled = [];
    const errors = [];
    for (const id of circleIds) {
      try {
        const data = await get(`/circles/${encodeURIComponent(id)}/members`);
        pulled.push(...(data?.members || []));
      } catch (error) {
        errors.push(error.message);
        log(`member fetch failed for a circle: ${error.message}`);
      }
    }
    if (pulled.length) {
      members = pulled;
      membersAt = now();
      lastOkAt = now();
      lastError = null;
    } else if (errors.length) {
      lastError = errors.at(-1);
    }
  }

  return {
    /** Fresh or cached member snapshot; concurrent callers share one pull. */
    async getMembers() {
      if (members.length && now() - membersAt < UPSTREAM_MIN_INTERVAL_MS) return members;
      inflight ??= pull().finally(() => { inflight = null; });
      await inflight;
      return members;
    },
    /** @returns {{state: 'OK'|'STALE'|'FAIL'|'INIT', detail: string}} */
    health() {
      if (!lastOkAt) return { state: 'INIT', detail: lastError || 'starting up - no successful pull yet' };
      const ageS = (now() - lastOkAt) / 1000;
      if (lastError && ageS > 60) return { state: 'FAIL', detail: lastError };
      if (ageS > 90) return { state: 'STALE', detail: `${Math.floor(ageS)}s since last successful update` };
      return { state: 'OK', detail: `${members.length} chasers` };
    },
    secondsSinceOk() {
      return lastOkAt ? (now() - lastOkAt) / 1000 : null;
    },
  };
}
