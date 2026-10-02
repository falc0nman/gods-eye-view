/**
 * Level II volume assembly — SERVER-SIDE (server/providers/nexrad-level2.js).
 *
 * Builds sweeps from radials as chunks arrive, so the low tilts are usable
 * while the rest of the volume is still being scanned. Chunks may arrive out
 * of order or twice: radials are keyed by elevation and azimuth number.
 * Pure: no I/O.
 */

import { momentValue, RADIAL_STATUS } from './level2.js';

/** Moments that render through the shared colour tables (8-bit words). */
export const LEVEL2_RENDER_GROUPS = Object.freeze({ REF: 'ref', VEL: 'vel' });

const VOLUMES_PER_SITE = 2;
const LATENCY_SAMPLES = 50;

/**
 * `KTLX/112/20260930-182908-033-I` → site, volume number, volume id, chunk
 * sequence and type (S start, I intermediate, E end).
 */
export function parseChunkKey(key) {
  const m = /^([A-Z0-9]{4})\/(\d{1,3})\/(\d{8}-\d{6})-(\d{3})-([SIE])$/.exec(
    String(key),
  );
  if (!m) return null;
  return {
    site: m[1],
    volumeNumber: Number(m[2]),
    volumeId: m[3],
    sequence: Number(m[4]),
    chunkType: m[5],
  };
}

/** `2026/09/30/KTLX/KTLX20260930_182908_V06` → site and volume id. */
export function parseVolumeKey(key) {
  const m = /(?:^|\/)([A-Z0-9]{4})(\d{8})_(\d{6})_V\d{2}$/.exec(String(key));
  return m ? { site: m[1], volumeId: `${m[2]}-${m[3]}` } : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function createSweep(radial) {
  return {
    elevationNumber: radial.elevationNumber,
    elevationDeg: radial.elevationDeg,
    azimuthSpacingDeg: radial.azimuthSpacingDeg,
    radials: new Map(),
    complete: false,
    firstRadialMs: radial.timeMs,
    lastRadialMs: radial.timeMs,
    revision: 0,
  };
}

/**
 * @param {{now?: () => number}} [options]
 */
export function createVolumeAssembler({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {volumes: Map<string, object>, latency: object[]}>} */
  const sites = new Map();

  function siteState(site) {
    let state = sites.get(site);
    if (!state) {
      state = { volumes: new Map(), latency: [] };
      sites.set(site, state);
    }
    return state;
  }

  function volumeFor(site, volumeId, init) {
    const state = siteState(site);
    let volume = state.volumes.get(volumeId);
    if (!volume) {
      volume = {
        id: volumeId,
        site,
        number: init.number ?? null,
        source: init.source,
        startMs: init.startMs ?? null,
        vcp: null,
        location: null,
        sweeps: new Map(),
        chunks: new Set(),
        complete: false,
        updatedMs: now(),
      };
      state.volumes.set(volumeId, volume);
      // Volume ids are UTC timestamps, so they sort chronologically.
      const ids = [...state.volumes.keys()].sort();
      while (ids.length > VOLUMES_PER_SITE) state.volumes.delete(ids.shift());
    }
    return volume;
  }

  function addRadials(volume, radials) {
    for (const radial of radials) {
      if (!volume.location && radial.site) volume.location = radial.site;
      if (volume.vcp === null && radial.vcp !== null) volume.vcp = radial.vcp;
      if (volume.startMs === null) volume.startMs = radial.timeMs;
      let sweep = volume.sweeps.get(radial.elevationNumber);
      if (!sweep) {
        sweep = createSweep(radial);
        volume.sweeps.set(radial.elevationNumber, sweep);
      }
      sweep.radials.set(radial.azimuthNumber, radial);
      sweep.firstRadialMs = Math.min(sweep.firstRadialMs, radial.timeMs);
      sweep.lastRadialMs = Math.max(sweep.lastRadialMs, radial.timeMs);
      sweep.revision += 1;
      if (
        radial.status === RADIAL_STATUS.END_ELEVATION ||
        radial.status === RADIAL_STATUS.END_VOLUME
      )
        sweep.complete = true;
      if (radial.status === RADIAL_STATUS.END_VOLUME) volume.complete = true;
    }
    volume.updatedMs = now();
  }

  /**
   * Add one normalized chunk record (see nexrad-level2.js normalize()).
   * @param {{data: {key: object, volume: object|null, radials: object[]}, ingestTime: number, provenance: object}} record
   */
  function addChunk(record) {
    const { key, volume: header, radials } = record.data;
    const volume = volumeFor(key.site, key.volumeId, {
      number: key.volumeNumber,
      source: 'chunks',
      startMs: header?.startMs,
    });
    if (header?.startMs) volume.startMs = header.startMs;
    volume.chunks.add(key.sequence);
    addRadials(volume, radials);
    if (key.chunkType === 'E') volume.complete = true;
    if (radials.length) {
      const lastRadialMs = Math.max(...radials.map((r) => r.timeMs));
      const lastModified = record.provenance.lastModified;
      const samples = siteState(key.site).latency;
      samples.push({
        at: record.ingestTime,
        radialToIngestMs: record.ingestTime - lastRadialMs,
        objectToIngestMs: Number.isFinite(lastModified)
          ? record.ingestTime - lastModified
          : null,
      });
      if (samples.length > LATENCY_SAMPLES)
        samples.splice(0, samples.length - LATENCY_SAMPLES);
    }
    return volume;
  }

  /** Add a whole completed volume (the fallback when chunks are unavailable). */
  function addVolume(site, volumeId, decoded) {
    const volume = volumeFor(site, volumeId, {
      source: 'volume',
      startMs: decoded.volume?.startMs,
    });
    addRadials(volume, decoded.radials);
    volume.complete = true;
    for (const sweep of volume.sweeps.values()) sweep.complete = true;
    return volume;
  }

  function newestVolume(site, { source } = {}) {
    const volumes = [...(sites.get(site)?.volumes.values() ?? [])]
      .filter((v) => !source || v.source === source)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return volumes.at(-1) ?? null;
  }

  function hasVolume(site, volumeId) {
    return Boolean(sites.get(site)?.volumes.has(volumeId));
  }

  function latency(site) {
    const samples = sites.get(site)?.latency ?? [];
    const pick = (field) => {
      const values = samples.map((s) => s[field]).filter(Number.isFinite);
      return { last: values.at(-1) ?? null, median: median(values) };
    };
    return {
      samples: samples.length,
      // Radar collected the chunk's last radial → GEV had it decoded.
      radialToIngestMs: pick('radialToIngestMs'),
      // NOAA wrote the chunk object → GEV had it decoded.
      objectToIngestMs: pick('objectToIngestMs'),
    };
  }

  function sweep(site, volumeId, elevationNumber) {
    return (
      sites.get(site)?.volumes.get(volumeId)?.sweeps.get(elevationNumber) ??
      null
    );
  }

  function volume(site, volumeId) {
    return sites.get(site)?.volumes.get(volumeId) ?? null;
  }

  function forget(site) {
    sites.delete(site);
  }

  return {
    addChunk,
    addVolume,
    newestVolume,
    hasVolume,
    latency,
    sweep,
    volume,
    forget,
  };
}

/** Radials one full sweep holds at its azimuth spacing. */
export function expectedRadials(sweep) {
  return Math.round(360 / sweep.azimuthSpacingDeg);
}

/**
 * One sweep moment in the shape the Level III renderer (./render.js) draws.
 * @returns {object|null} null when no radial carries that moment.
 */
export function sweepProduct(sweep, momentName, location) {
  const group = LEVEL2_RENDER_GROUPS[momentName];
  if (!group || !location) return null;
  const radials = [];
  let reference = null;
  let bins = 0;
  for (const radial of sweep.radials.values()) {
    const moment = radial.moments[momentName];
    if (!moment || moment.wordSize !== 8) continue;
    reference ??= moment;
    bins = Math.max(bins, moment.gates);
    radials.push({
      start: radial.azimuthDeg - radial.azimuthSpacingDeg / 2,
      delta: radial.azimuthSpacingDeg,
      levels: moment.data,
    });
  }
  if (!reference) return null;
  const gateKm = reference.gateM / 1000;
  return {
    group,
    site: location,
    scanMs: sweep.firstRadialMs,
    elevationDeg: sweep.elevationDeg,
    gateKm,
    // Gate ranges are centres; the renderer indexes gates from their edges.
    firstBin: Math.max(
      0,
      Math.round(
        (reference.firstGateM - reference.gateM / 2) / reference.gateM,
      ),
    ),
    bins,
    radials,
    valueOf: (level) => momentValue(reference, level),
  };
}
