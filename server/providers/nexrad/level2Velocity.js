/**
 * Level II velocity products (GW-72) — SERVER-SIDE (server/providers/nexrad-level2.js).
 *
 * Dealiased velocity (VDA) and storm-relative velocity (SRV) for one sweep,
 * computed from the assembled radials and cached per sweep revision, so a
 * sweep is dealiased once per chunk that changes it, not once per request.
 */

import { momentValue } from './level2.js';
import { dealiasSweep, stormRelative } from './dealias.js';

/** Derived products are drawn with the velocity colour table, in m/s. */
const ENCODE_SCALE = 1;
const ENCODE_OFFSET = 129; // levels 2…255 → −127…+126 m/s; 0 = no data

const cache = new WeakMap(); // sweep → {revision, reference, referenceRevision, result}

/** Velocity radials of a sweep in azimuth order, as a row-major grid. */
export function sweepVelocityGrid(sweep) {
  const radials = [...sweep.radials.values()]
    .filter((r) => r.moments.VEL)
    .sort((a, b) => a.azimuthDeg - b.azimuthDeg);
  if (!radials.length) return null;
  const reference = radials[0].moments.VEL;
  const gates = Math.max(...radials.map((r) => r.moments.VEL.gates));
  const velocity = new Float32Array(radials.length * gates).fill(NaN);
  radials.forEach((radial, row) => {
    const moment = radial.moments.VEL;
    for (let g = 0; g < moment.gates; g += 1) {
      const value = momentValue(moment, moment.data[g]);
      if (typeof value === 'number') velocity[row * gates + g] = value;
    }
  });
  const nyquists = radials
    .map((r) => r.nyquistMs)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const spacing = radials[0].azimuthSpacingDeg;
  return {
    radials,
    gates,
    velocity,
    gateM: reference.gateM,
    firstGateM: reference.firstGateM,
    nyquist: nyquists.length ? nyquists[nyquists.length >> 1] : null,
    // Only a full circle wraps; a partial sweep's ends are not neighbours.
    wrap: radials.length >= Math.round(360 / spacing),
  };
}

/**
 * A dealiased reference sweep resampled onto `grid`: nearest radial by
 * azimuth, same gate when the gate geometry matches (NaN elsewhere).
 */
function referenceGrid(grid, ref) {
  if (!ref || ref.gateM !== grid.gateM || ref.firstGateM !== grid.firstGateM)
    return null;
  const spacing = grid.radials[0].azimuthSpacingDeg;
  const slots = Math.round(360 / spacing);
  const rowAt = new Int32Array(slots).fill(-1);
  ref.radials.forEach((radial, row) => {
    rowAt[Math.floor(radial.azimuthDeg / spacing) % slots] = row;
  });
  const out = new Float32Array(grid.radials.length * grid.gates).fill(NaN);
  grid.radials.forEach((radial, row) => {
    const refRow = rowAt[Math.floor(radial.azimuthDeg / spacing) % slots];
    if (refRow < 0) return;
    const n = Math.min(grid.gates, ref.gates);
    for (let g = 0; g < n; g += 1)
      out[row * grid.gates + g] = ref.velocity[refRow * ref.gates + g];
  });
  return out;
}

/**
 * Dealiased velocity for a sweep, cached until the sweep (or its reference)
 * changes.
 * @param {object} sweep
 * @param {{referenceOf?: (sweep) => object|null}} [options] - the previous
 *   sweep at this tilt, whose dealiased field anchors each echo to the right
 *   Nyquist interval (see dealias.js step 4).
 */
export function dealiasedSweep(sweep, { referenceOf = () => null } = {}) {
  const referenceSweep = referenceOf(sweep);
  const hit = cache.get(sweep);
  if (
    hit &&
    hit.revision === sweep.revision &&
    hit.reference === referenceSweep &&
    hit.referenceRevision === referenceSweep?.revision
  )
    return hit.result;
  const grid = sweepVelocityGrid(sweep);
  let result = null;
  if (grid) {
    // Assemblers keep two volumes per radar, so this recursion is one deep.
    const ref = referenceSweep
      ? dealiasedSweep(referenceSweep, { referenceOf })
      : null;
    const { velocity, unfolded, regions, referenced } = dealiasSweep({
      radials: grid.radials.length,
      gates: grid.gates,
      velocity: grid.velocity,
      nyquist: grid.nyquist,
      wrap: grid.wrap,
      reference: ref ? referenceGrid(grid, ref) : null,
    });
    result = {
      ...grid,
      folded: grid.velocity,
      velocity,
      unfolded,
      regions,
      referenced,
    };
  }
  cache.set(sweep, {
    revision: sweep.revision,
    reference: referenceSweep,
    referenceRevision: referenceSweep?.revision,
    result,
  });
  return result;
}

function encode(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(
    2,
    Math.min(255, Math.round(value * ENCODE_SCALE + ENCODE_OFFSET)),
  );
}

/**
 * VDA or SRV for the Level III renderer.
 * @param {'VDA'|'SRV'} name
 * @param {{fromDeg: number, speedKt: number}} [motion] - required for SRV.
 */
export function velocityProduct(
  sweep,
  name,
  location,
  motion = null,
  options = {},
) {
  if (!location || (name === 'SRV' && !motion)) return null;
  const data = dealiasedSweep(sweep, options);
  if (!data) return null;
  const { radials, gates, velocity } = data;
  return {
    group: 'vel',
    site: location,
    scanMs: sweep.firstRadialMs,
    elevationDeg: sweep.elevationDeg,
    gateKm: data.gateM / 1000,
    firstBin: Math.max(
      0,
      Math.round((data.firstGateM - data.gateM / 2) / data.gateM),
    ),
    bins: gates,
    radials: radials.map((radial, row) => {
      const levels = new Uint8Array(gates);
      for (let g = 0; g < gates; g += 1) {
        const v = velocity[row * gates + g];
        levels[g] = encode(
          name === 'SRV' && Number.isFinite(v)
            ? stormRelative(v, motion, radial.azimuthDeg)
            : v,
        );
      }
      return {
        start: radial.azimuthDeg - radial.azimuthSpacingDeg / 2,
        delta: radial.azimuthSpacingDeg,
        levels,
      };
    }),
    valueOf: (level) =>
      level === 0 ? null : (level - ENCODE_OFFSET) / ENCODE_SCALE,
  };
}

const EARTH_RADIUS_KM = 6371;

/**
 * Values at a point: raw and dealiased velocity, SRV and reflectivity — what
 * couplet interrogation (GW-8) samples.
 */
export function sweepValueAt(
  sweep,
  location,
  lat,
  lon,
  motion = null,
  options = {},
) {
  const rad = Math.PI / 180;
  const dy = (lat - location.lat) * rad * EARTH_RADIUS_KM;
  const dx = (lon - location.lon) * rad * EARTH_RADIUS_KM * Math.cos(lat * rad);
  const rangeKm = Math.hypot(dx, dy);
  let azimuthDeg = Math.atan2(dx, dy) / rad;
  if (azimuthDeg < 0) azimuthDeg += 360;
  const base = {
    rangeKm,
    azimuthDeg,
    inRange: false,
    ref: null,
    vel: null,
    velDealiased: null,
    srv: null,
  };
  const radial = [...sweep.radials.values()].find((r) => {
    const offset =
      (((azimuthDeg - r.azimuthDeg + r.azimuthSpacingDeg / 2) % 360) + 360) %
      360;
    return offset < r.azimuthSpacingDeg;
  });
  if (!radial) return base;
  const at = (moment) => {
    if (!moment) return { gate: -1, value: null };
    const gate = Math.floor(
      (rangeKm * 1000 - (moment.firstGateM - moment.gateM / 2)) / moment.gateM,
    );
    if (gate < 0 || gate >= moment.gates) return { gate: -1, value: null };
    return { gate, value: momentValue(moment, moment.data[gate]) };
  };
  const ref = at(radial.moments.REF);
  const vel = at(radial.moments.VEL);
  let velDealiased = null;
  if (vel.gate >= 0) {
    const data = dealiasedSweep(sweep, options);
    const row = data?.radials.indexOf(radial) ?? -1;
    const v = row >= 0 ? data.velocity[row * data.gates + vel.gate] : NaN;
    velDealiased = Number.isFinite(v) ? v : null;
  }
  return {
    ...base,
    inRange: ref.gate >= 0 || vel.gate >= 0,
    ref: ref.value,
    vel: vel.value,
    velDealiased,
    srv:
      motion && velDealiased !== null
        ? stormRelative(velDealiased, motion, radial.azimuthDeg)
        : null,
    nyquistMs: radial.nyquistMs,
  };
}
