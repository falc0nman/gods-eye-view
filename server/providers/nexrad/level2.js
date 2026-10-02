/**
 * NEXRAD Level II (Archive II) decoder — SERVER-SIDE (server/providers/nexrad-level2.js).
 *
 * Decodes one real-time chunk from NOAA's `unidata-nexrad-level2-chunks`
 * bucket, or a whole completed volume from `unidata-nexrad-level2` — both use
 * the same records. Pure: the bzip2 decompressor is injected.
 *
 * Format (RDA/RPG ICD 2620002 and 2620010):
 *   - An optional 24-byte volume header ("AR2V00xx." + extension, Julian
 *     date, ms of day, ICAO); only the first (S) chunk of a volume and whole
 *     volume files carry one.
 *   - LDM records: a 4-byte big-endian signed length (sign ignored) followed
 *     by that many bytes of bzip2 data.
 *   - Each decompressed record holds messages, each preceded by a 12-byte
 *     channel terminal manager (CTM) pad and a 16-byte message header.
 *     Message 31 (generic digital radar data) is variable-length; every other
 *     type fills a fixed 2432-byte frame.
 */

const VOLUME_HEADER_BYTES = 24;
const CTM_BYTES = 12;
const MESSAGE_HEADER_BYTES = 16;
const FIXED_FRAME_BYTES = 2432;
const MS_PER_DAY = 86_400_000;

/** Radial status (message 31) values. */
export const RADIAL_STATUS = Object.freeze({
  START_ELEVATION: 0,
  INTERMEDIATE: 1,
  END_ELEVATION: 2,
  START_VOLUME: 3,
  END_VOLUME: 4,
  START_ELEVATION_LAST: 5,
});

/** Moments decoded by default (all of them when `moments` is null). */
export const LEVEL2_MOMENTS = Object.freeze([
  'REF',
  'VEL',
  'SW',
  'ZDR',
  'PHI',
  'RHO',
  'CFP',
]);

/** NEXRAD dates: day 1 is 1970-01-01. */
const julianMs = (days, msOfDay) => (days - 1) * MS_PER_DAY + msOfDay;

const ascii = (bytes, start, length) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/**
 * Split a chunk or volume file into its volume header (if any) and its
 * decompressed LDM records.
 * @param {Uint8Array} bytes
 * @param {{bunzip: (data: Uint8Array) => Uint8Array}} codec
 */
export function readLevel2Records(bytes, { bunzip }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let volume = null;
  if (bytes.length >= VOLUME_HEADER_BYTES && ascii(bytes, 0, 4) === 'AR2V') {
    volume = {
      version: ascii(bytes, 0, 9).replace(/\.$/, ''),
      startMs: julianMs(view.getUint32(12), view.getUint32(16)),
      icao: ascii(bytes, 20, 4).trim(),
    };
    offset = VOLUME_HEADER_BYTES;
  }
  const records = [];
  while (offset + 4 <= bytes.length) {
    const length = Math.abs(view.getInt32(offset));
    offset += 4;
    if (!length || offset + length > bytes.length)
      throw new Error('Truncated Level II record');
    records.push(bunzip(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return { volume, records };
}

function readMoment(view, at, name) {
  const gates = view.getUint16(at + 8);
  const firstGateM = view.getUint16(at + 10);
  const gateM = view.getUint16(at + 12);
  const wordSize = view.getUint8(at + 19);
  const scale = view.getFloat32(at + 20);
  const offset = view.getFloat32(at + 24);
  const start = view.byteOffset + at + 28;
  const data =
    wordSize === 16
      ? Uint16Array.from({ length: gates }, (_, i) =>
          view.getUint16(at + 28 + i * 2),
        )
      : new Uint8Array(view.buffer.slice(start, start + gates));
  return { name, gates, firstGateM, gateM, wordSize, scale, offset, data };
}

/** Decode one message 31 radial starting at the message body. */
function readRadial(view, at, wanted) {
  const radial = {
    icao: String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3),
    ),
    timeMs: julianMs(view.getUint16(at + 8), view.getUint32(at + 4)),
    azimuthNumber: view.getUint16(at + 10),
    azimuthDeg: view.getFloat32(at + 12),
    azimuthSpacingDeg: view.getUint8(at + 20) === 1 ? 0.5 : 1,
    status: view.getUint8(at + 21),
    elevationNumber: view.getUint8(at + 22),
    cut: view.getUint8(at + 23),
    elevationDeg: view.getFloat32(at + 24),
    site: null,
    vcp: null,
    nyquistMs: null,
    unambiguousRangeKm: null,
    moments: {},
  };
  const blocks = Math.min(view.getUint16(at + 30), 10);
  for (let i = 0; i < blocks; i += 1) {
    const pointer = view.getUint32(at + 32 + i * 4);
    if (!pointer) continue;
    const b = at + pointer;
    const kind = String.fromCharCode(view.getUint8(b));
    const name = String.fromCharCode(
      view.getUint8(b + 1),
      view.getUint8(b + 2),
      view.getUint8(b + 3),
    ).trim();
    if (kind === 'R' && name === 'VOL') {
      radial.site = {
        lat: view.getFloat32(b + 8),
        lon: view.getFloat32(b + 12),
        // Site height (m MSL) + feedhorn height (m above ground) → feet.
        heightFt: (view.getInt16(b + 16) + view.getUint16(b + 18)) * 3.28084,
      };
      radial.vcp = view.getUint16(b + 40);
    } else if (kind === 'R' && name === 'RAD') {
      // Unambiguous range (0.1 km) and Nyquist velocity (0.01 m/s).
      radial.unambiguousRangeKm = view.getUint16(b + 6) / 10;
      radial.nyquistMs = view.getUint16(b + 16) / 100;
    } else if (kind === 'D' && (!wanted || wanted.has(name))) {
      radial.moments[name] = readMoment(view, b, name);
    }
  }
  return radial;
}

/**
 * Decode every message 31 radial in a chunk (or volume file).
 * @param {Uint8Array} bytes
 * @param {{bunzip: Function, moments?: string[]|null}} options
 * @returns {{volume: object|null, radials: object[]}}
 */
export function decodeLevel2(bytes, { bunzip, moments = null }) {
  const wanted = moments ? new Set(moments) : null;
  const { volume, records } = readLevel2Records(bytes, { bunzip });
  const radials = [];
  for (const record of records) {
    const view = new DataView(
      record.buffer,
      record.byteOffset,
      record.byteLength,
    );
    let offset = 0;
    while (offset + CTM_BYTES + MESSAGE_HEADER_BYTES <= record.length) {
      const header = offset + CTM_BYTES;
      const sizeHalfwords = view.getUint16(header);
      const type = view.getUint8(header + 3);
      if (type === 31) {
        radials.push(readRadial(view, header + MESSAGE_HEADER_BYTES, wanted));
        offset += CTM_BYTES + sizeHalfwords * 2;
      } else {
        offset += FIXED_FRAME_BYTES;
      }
      if (!sizeHalfwords && type === 0) break; // zero padding at record end
    }
  }
  return { volume, radials };
}

/** Physical value of one gate word: null below threshold, 'RF' range folded. */
export function momentValue(moment, word) {
  if (word === 0) return null;
  if (word === 1) return 'RF';
  return (word - moment.offset) / moment.scale;
}
