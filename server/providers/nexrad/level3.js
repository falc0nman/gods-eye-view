/**
 * NEXRAD Level III decoder — SERVER-SIDE (server/providers/nexrad.js).
 *
 * Reads one product file from NOAA's public `unidata-nexrad-level3` bucket
 * and returns its radials as physical values. Pure: the bzip2 decompressor is
 * injected, so tests and the server can share it.
 *
 * Format (NEXRAD ICD 2620001): a 30-byte WMO/AWIPS text header, the Message
 * Header Block (18 bytes), the Product Description Block (102 bytes), then
 * the Product Symbology Block — bzip2-compressed for the digital products
 * (PDB halfword 51 == 1). Two radial packet formats occur:
 *   16      Digital Radial Data Array — one byte per gate (N0B, N0G, N0C, …)
 *   0xAF1F  Run-length encoded radials — 16 levels (N0S storm-relative velocity)
 *
 * Data levels → values follow the per-product rules of the ICD (as also
 * implemented by MetPy's Level3File mappers).
 */

/** Product code → decoding family, gate length (km) and display group. */
export const LEVEL3_PRODUCT_CODES = Object.freeze({
  153: Object.freeze({ kind: 'linear', gateKm: 0.25, group: 'ref' }), // super-res reflectivity (dBZ)
  154: Object.freeze({ kind: 'linear', gateKm: 0.25, group: 'vel' }), // super-res velocity (m/s)
  56: Object.freeze({ kind: 'legacy', gateKm: 1, group: 'srv' }), // storm-relative velocity (kt)
  159: Object.freeze({ kind: 'float', gateKm: 0.25, group: 'zdr' }), // differential reflectivity (dB)
  161: Object.freeze({ kind: 'float', gateKm: 0.25, group: 'cc' }), // correlation coefficient
  163: Object.freeze({ kind: 'float', gateKm: 0.25, group: 'kdp' }), // specific differential phase (°/km)
  165: Object.freeze({ kind: 'hc', gateKm: 0.25, group: 'hc' }), // hydrometeor classification
  134: Object.freeze({ kind: 'vil', gateKm: 1, group: 'vil' }), // digital VIL (kg/m²)
  135: Object.freeze({ kind: 'et', gateKm: 1, group: 'et' }), // enhanced echo tops (kft)
});

/** Hydrometeor classes by data level. */
export const HC_CLASSES = Object.freeze({
  10: 'BI',
  20: 'GC',
  30: 'IC',
  40: 'DS',
  50: 'WS',
  60: 'RA',
  70: 'HR',
  80: 'BD',
  90: 'GR',
  100: 'HA',
  110: 'LH',
  120: 'GH',
  140: 'UK',
  150: 'RF',
});

/** Special (non-value) results. */
export const RANGE_FOLDED = 'RF';

/** NEXRAD 16-bit float: 1 sign, 5 exponent (bias 16), 10 fraction bits. */
export function nexradFloat16(bits) {
  const frac = bits & 0x03ff;
  const exp = (bits >> 10) & 0x1f;
  const value = exp ? 2 ** (exp - 16) * (1 + frac / 1024) : frac / 512;
  return bits >> 15 ? -value : value;
}

const EARTH_RADIUS_KM = 6371;

/**
 * Height of the beam centre above the radar's ground, standard 4/3-earth
 * refraction model — how high off the ground a signature at that range is.
 * @returns {number} feet above MSL (radar height included).
 */
export function beamHeightFt(rangeKm, elevationDeg, siteHeightFt = 0) {
  const ke = (4 / 3) * EARTH_RADIUS_KM;
  const theta = (elevationDeg * Math.PI) / 180;
  const hKm =
    Math.sqrt(rangeKm ** 2 + ke ** 2 + 2 * rangeKm * ke * Math.sin(theta)) - ke;
  return hKm * 3280.84 + siteHeightFt;
}

/**
 * The decoded value at a point (same flat-earth geometry the renderer uses).
 * @returns {{value: number|string|null, rangeKm: number, azimuthDeg: number, inRange: boolean}}
 */
export function valueAt(product, lat, lon) {
  const rad = Math.PI / 180;
  const dy = (lat - product.site.lat) * rad * EARTH_RADIUS_KM;
  const dx =
    (lon - product.site.lon) * rad * EARTH_RADIUS_KM * Math.cos(lat * rad);
  const rangeKm = Math.sqrt(dx * dx + dy * dy);
  let azimuthDeg = Math.atan2(dx, dy) / rad;
  if (azimuthDeg < 0) azimuthDeg += 360;
  const gate = Math.floor(rangeKm / product.gateKm) - product.firstBin;
  const inRange = gate >= 0 && gate < product.bins;
  let value = null;
  if (inRange) {
    const radial = product.radials.find((r) => {
      const offset = (((azimuthDeg - r.start) % 360) + 360) % 360;
      return offset < r.delta;
    });
    const level = radial?.levels[gate];
    if (level !== undefined) value = product.valueOf(level);
  }
  return { value, rangeKm, azimuthDeg, inRange };
}

/** Locate the end of the WMO text header (two CR CR LF line endings). */
function wmoHeaderLength(bytes) {
  let seen = 0;
  for (let i = 0; i < Math.min(bytes.length - 2, 64); i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
      seen += 1;
      i += 2;
      if (seen === 2) return i + 1;
    }
  }
  // No WMO header: the file starts at the Message Header Block.
  return 0;
}

/**
 * Build the level → value function for a product.
 * @returns {(level: number) => number|string|null} null = no data.
 */
function levelMapper(info, hw, view, pdb) {
  const halfword = (n) => hw(n);
  switch (info.kind) {
    case 'linear': {
      const min = halfword(31) / 10;
      const inc = halfword(32) / 10;
      return (level) =>
        level === 0
          ? null
          : level === 1
            ? RANGE_FOLDED
            : min + (level - 2) * inc;
    }
    case 'float': {
      // Halfwords 31-32 / 33-34 hold IEEE float32 scale and offset.
      // Halfword 36 is the highest data level; 37 counts the leading flag
      // levels (0 = below threshold, 1 = range folded).
      const scale = view.getFloat32(pdb + (31 - 10) * 2);
      const offset = view.getFloat32(pdb + (33 - 10) * 2);
      const maxLevel = halfword(36) || 255;
      const leading = halfword(37) || 2;
      return (level) =>
        level === 0
          ? null
          : level === 1
            ? RANGE_FOLDED
            : level < leading || level > maxLevel
              ? null
              : (level - offset) / scale;
    }
    case 'hc':
      return (level) => {
        const cls = HC_CLASSES[level];
        return !cls || cls === 'UK' ? null : cls;
      };
    case 'vil': {
      const linScale = nexradFloat16(halfword(31) & 0xffff);
      const linOffset = nexradFloat16(halfword(32) & 0xffff);
      const logStart = halfword(33);
      const logScale = nexradFloat16(halfword(34) & 0xffff);
      const logOffset = nexradFloat16(halfword(35) & 0xffff);
      return (level) => {
        if (level < 2) return null;
        return level < logStart
          ? (level - linOffset) / linScale
          : Math.exp((level - logOffset) / logScale);
      };
    }
    case 'et': {
      const mask = halfword(31);
      const scale = halfword(32) || 1;
      const offset = halfword(33);
      return (level) => {
        const v = level & mask;
        return v < offset ? null : (v - offset) / scale;
      };
    }
    case 'legacy': {
      // 16 coded thresholds: high byte flags, low byte magnitude.
      const values = [];
      for (let i = 0; i < 16; i += 1) {
        const raw = halfword(31 + i) & 0xffff;
        const codes = raw >> 8;
        let val = raw & 0xff;
        if (codes & 0x80) {
          values.push(val === 3 ? RANGE_FOLDED : null); // 1 TH, 2 ND, 3 RF
          continue;
        }
        if (codes & 0x20) val *= 0.01;
        else if (codes & 0x10) val *= 0.05;
        else if (codes & 0x08) val *= 0.1;
        values.push(codes & 0x01 ? -val : val);
      }
      return (level) => values[level] ?? null;
    }
    default:
      throw new Error(`unsupported product kind ${info.kind}`);
  }
}

function readRadialsDigital(view, offset) {
  const firstBin = view.getInt16(offset + 2);
  const bins = view.getInt16(offset + 4);
  const count = view.getInt16(offset + 12);
  let p = offset + 14;
  const radials = [];
  for (let r = 0; r < count; r += 1) {
    const nBytes = view.getInt16(p);
    const start = view.getInt16(p + 2) / 10;
    const delta = view.getInt16(p + 4) / 10;
    const levels = new Uint8Array(
      view.buffer,
      view.byteOffset + p + 6,
      Math.min(nBytes, bins),
    );
    radials.push({ start, delta, levels });
    p += 6 + nBytes + (nBytes % 2);
  }
  return { firstBin, bins, radials };
}

function readRadialsRle(view, offset) {
  const firstBin = view.getInt16(offset + 2);
  const bins = view.getInt16(offset + 4);
  const count = view.getInt16(offset + 12);
  let p = offset + 14;
  const radials = [];
  for (let r = 0; r < count; r += 1) {
    const halfwords = view.getInt16(p);
    const start = view.getInt16(p + 2) / 10;
    const delta = view.getInt16(p + 4) / 10;
    const levels = new Uint8Array(bins);
    let gate = 0;
    for (let i = 0; i < halfwords * 2; i += 1) {
      const byte = view.getUint8(p + 6 + i);
      const run = byte >> 4;
      const level = byte & 0x0f;
      for (let k = 0; k < run && gate < bins; k += 1) levels[gate++] = level;
    }
    radials.push({ start, delta, levels });
    p += 6 + halfwords * 2;
  }
  return { firstBin, bins, radials };
}

/**
 * Decode a Level III product file.
 * @param {Uint8Array} bytes Whole file as downloaded.
 * @param {{bunzip: (data: Uint8Array) => Uint8Array}} deps
 * @returns {{productCode: number, group: string, site: {lat: number, lon: number, heightFt: number},
 *   scanMs: number, elevationDeg: number|null, gateKm: number, firstBin: number, bins: number,
 *   radials: Array<{start: number, delta: number, levels: Uint8Array}>,
 *   valueOf: (level: number) => number|string|null}}
 */
export function decodeLevel3(bytes, { bunzip }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const mhb = wmoHeaderLength(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const productCode = view.getInt16(mhb);
  const info = LEVEL3_PRODUCT_CODES[productCode];
  if (!info)
    throw new Error(`unsupported Level III product code ${productCode}`);

  const pdb = mhb + 18;
  // Halfword n (1-based, counting from the Message Header Block).
  const hw = (n) => view.getInt16(mhb + (n - 1) * 2);
  if (hw(10) !== -1)
    throw new Error('missing Product Description Block divider');
  const lat = view.getInt32(mhb + (11 - 1) * 2) / 1000;
  const lon = view.getInt32(mhb + (13 - 1) * 2) / 1000;
  const heightFt = hw(15);
  const scanDay = hw(21);
  const scanSeconds = view.getInt32(mhb + (22 - 1) * 2);
  const scanMs = ((scanDay - 1) * 86400 + scanSeconds) * 1000;
  const isTilt = ['ref', 'vel', 'srv', 'zdr', 'cc', 'kdp', 'hc'].includes(
    info.group,
  );
  const elevationDeg = isTilt ? hw(30) / 10 : null;
  const valueOf = levelMapper(info, hw, view, pdb);

  // Symbology (+ graphic/tabular) follows the PDB, compressed or not.
  let symbology = data.subarray(pdb + 102);
  if (info.kind !== 'legacy' && hw(51) === 1) symbology = bunzip(symbology);
  const sview = new DataView(
    symbology.buffer,
    symbology.byteOffset,
    symbology.byteLength,
  );
  if (sview.getInt16(0) !== -1 || sview.getInt16(2) !== 1)
    throw new Error('missing Product Symbology Block');
  // Block header (10 bytes) + first layer header (6 bytes) → first packet.
  const packetAt = 16;
  const packetCode = sview.getUint16(packetAt);
  let radialData;
  if (packetCode === 16) radialData = readRadialsDigital(sview, packetAt);
  else if (packetCode === 0xaf1f) radialData = readRadialsRle(sview, packetAt);
  else throw new Error(`unsupported packet 0x${packetCode.toString(16)}`);

  return {
    productCode,
    group: info.group,
    site: { lat, lon, heightFt },
    scanMs,
    elevationDeg,
    gateKm: info.gateKm,
    ...radialData,
    valueOf,
  };
}
