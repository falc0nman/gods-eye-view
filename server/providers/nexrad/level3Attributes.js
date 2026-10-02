/**
 * NEXRAD Level III storm attributes — SERVER-SIDE (server/providers/nexrad.js).
 *
 * Decodes the detection products into plain features:
 *
 *   58  NST  Storm Tracking Information: storm cells with current position,
 *            past track, forecast positions (15–60 min), movement and
 *            forecast error; max reflectivity and its height.
 *   141 NMD  Mesocyclone Detection: circulations with strength rank, rotational
 *            and delta velocity, base and depth, TVS flag, motion, past and
 *            forecast track.
 *
 * Positions come from the symbology block (packets 2/15/20, and 23/24 holding
 * past/forecast positions as embedded packets 2, 6 and 25), in ¼ km from the
 * radar with +x east and +y north. Attributes come from the tabular block (and
 * the graphic block for NST max dBZ), matched by storm/circulation ID.
 * Motions are meteorological: the direction the storm moves FROM.
 *
 * Hail Index (NHI), TVS (NTV) and Storm Structure (NSS) use the same packets
 * but have not been published to the unidata-nexrad-level3 bucket since 2022.
 * Pure: no I/O.
 */

const EARTH_RADIUS_KM = 6371;
const KM_PER_NM = 1.852;
const QUARTER_KM = 0.25;

export const LEVEL3_ATTRIBUTE_PRODUCTS = Object.freeze({
  NST: 58,
  NMD: 141,
});

function wmoHeaderLength(bytes) {
  let seen = 0;
  for (let i = 0; i < Math.min(bytes.length - 2, 64); i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 13 && bytes[i + 2] === 10) {
      seen += 1;
      if (seen === 2) return i + 3;
    }
  }
  throw new Error('missing WMO/AWIPS header');
}

/** Great-circle destination from the radar along an azimuth. */
export function destination(site, azimuthDeg, rangeKm) {
  const rad = Math.PI / 180;
  const d = rangeKm / EARTH_RADIUS_KM;
  const lat1 = site.lat * rad;
  const lon1 = site.lon * rad;
  const brng = azimuthDeg * rad;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    lat: Math.round((lat2 / rad) * 1e5) / 1e5,
    lon: Math.round((((lon2 / rad + 540) % 360) - 180) * 1e5) / 1e5,
  };
}

/** ¼ km screen units → lat/lon, azimuth and range. */
function locate(site, i, j) {
  const x = i * QUARTER_KM;
  const y = j * QUARTER_KM;
  const rangeKm = Math.hypot(x, y);
  let azimuthDeg = (Math.atan2(x, y) * 180) / Math.PI;
  if (azimuthDeg < 0) azimuthDeg += 360;
  return {
    ...destination(site, azimuthDeg, rangeKm),
    azimuthDeg: Math.round(azimuthDeg * 10) / 10,
    rangeKm: Math.round(rangeKm * 10) / 10,
  };
}

/** Header, symbology packets, and the text of the tabular/graphic blocks. */
export function readLevel3Blocks(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const mhb = wmoHeaderLength(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hw = (n) => view.getInt16(mhb + (n - 1) * 2);
  const word = (n) => view.getInt32(mhb + (n - 1) * 2);
  if (hw(10) !== -1)
    throw new Error('missing Product Description Block divider');
  const productCode = hw(1);
  const site = {
    lat: word(11) / 1000,
    lon: word(13) / 1000,
    heightFt: hw(15),
  };
  const scanMs = ((hw(21) - 1) * 86400 + word(22)) * 1000;
  if (hw(51) === 1)
    throw new Error('compressed attribute products are not supported');
  const at = (halfwords) => (halfwords > 0 ? mhb + halfwords * 2 : -1);

  const packets = [];
  const symbology = at(word(55));
  if (symbology > 0 && symbology + 10 <= data.length) {
    if (view.getInt16(symbology) !== -1 || view.getInt16(symbology + 2) !== 1)
      throw new Error('missing Product Symbology Block');
    const layers = view.getInt16(symbology + 8);
    let p = symbology + 10;
    for (let layer = 0; layer < layers; layer += 1) {
      const end = p + 6 + view.getInt32(p + 2);
      let q = p + 6;
      while (q + 4 <= end) {
        const code = view.getUint16(q);
        const length = view.getUint16(q + 2);
        packets.push({ code, view, start: q + 4, length });
        q += 4 + length;
      }
      p = end;
    }
  }

  const tabular = [];
  const tab = at(word(59));
  if (tab > 0) {
    // Block header (8), then a copy of the MHB + PDB (120), then pages.
    let q = tab + 8 + 120;
    if (view.getInt16(q) !== -1) throw new Error('bad tabular block');
    const pages = view.getInt16(q + 2);
    q += 4;
    for (let page = 0; page < pages && q < data.length; page += 1) {
      const lines = [];
      for (;;) {
        const n = view.getInt16(q);
        q += 2;
        if (n === -1) break;
        lines.push(String.fromCharCode(...data.subarray(q, q + n)));
        q += n;
      }
      tabular.push(lines);
    }
  }

  const graphic = [];
  const gra = at(word(57));
  if (gra > 0) {
    const pages = view.getInt16(gra + 8);
    let q = gra + 10;
    for (let page = 0; page < pages && q < data.length; page += 1) {
      const end = q + 4 + view.getInt16(q + 2);
      q += 4;
      const lines = [];
      while (q + 4 <= end) {
        const code = view.getUint16(q);
        const length = view.getUint16(q + 2);
        if (code === 8)
          lines.push(
            String.fromCharCode(...data.subarray(q + 10, q + 4 + length)),
          );
        q += 4 + length;
      }
      graphic.push(lines);
    }
  }
  return { productCode, site, scanMs, packets, tabular, graphic };
}

const pos = (view, at) => ({ i: view.getInt16(at), j: view.getInt16(at + 2) });

/** Positions held by a past (23) or forecast (24) track packet. */
function trackPoints(packet) {
  const { view, start, length } = packet;
  const points = [];
  let circle = null;
  let q = start;
  while (q + 4 <= start + length) {
    const code = view.getUint16(q);
    const n = view.getUint16(q + 2);
    if (code === 2) points.push(pos(view, q + 4));
    else if (code === 25)
      circle = { ...pos(view, q + 4), radius: view.getInt16(q + 8) };
    q += 4 + n;
  }
  return { points, circle };
}

/**
 * Group symbology packets by the feature they follow: a position packet
 * (15 storm ID for NST, 20 point feature for NMD) opens a feature, and the
 * 23/24 track packets after it belong to it.
 */
function features(packets, opener) {
  const out = [];
  for (const packet of packets) {
    if (packet.code === opener) {
      out.push({ packet, past: [], forecast: [], circle: null });
    } else if ((packet.code === 23 || packet.code === 24) && out.length) {
      const { points, circle } = trackPoints(packet);
      const feature = out.at(-1);
      if (packet.code === 23) feature.past = points;
      else {
        feature.forecast = points;
        feature.circle = circle;
      }
    }
  }
  return out;
}

const motionOf = (deg, kt) =>
  deg === undefined
    ? null
    : { fromDeg: Number(deg) % 360, speedKt: Number(kt) };

const qualified = (text) => {
  const m = /^([<>])?\s*(\d+(?:\.\d+)?)$/.exec(String(text).trim());
  return m
    ? {
        value: Number(m[2]),
        qualifier: m[1] === '<' ? 'below' : m[1] === '>' ? 'above' : null,
      }
    : null;
};

const FORECAST_MINUTES = [15, 30, 45, 60];

/** Storm Tracking Information (NST, product 58). */
export function decodeStormTracks(bytes) {
  const blocks = readLevel3Blocks(bytes);
  if (blocks.productCode !== 58)
    throw new Error(`expected product 58 (NST), got ${blocks.productCode}`);
  const { site } = blocks;
  const rows = new Map();
  let average = null;
  for (const line of blocks.tabular.flat()) {
    const avg = /AVG SPEED\s+(\d+)\s+KTS\s+AVG DIRECTION\s+(\d+)\s+DEG/.exec(
      line,
    );
    if (avg) average = motionOf(avg[2], avg[1]);
    const m =
      /^\s+([A-Z]\d)\s+(\d+)\/\s*(\d+)\s+(?:NEW|(\d+)\/\s*(\d+))\s+(.*?)\s+(\d+\.\d)\/\s*(\d+\.\d)\s*$/.exec(
        line,
      );
    if (!m) continue;
    rows.set(m[1], {
      motion: motionOf(m[4], m[5]),
      isNew: m[4] === undefined,
      errorNm: { forecast: Number(m[7]), mean: Number(m[8]) },
    });
  }
  // Graphic block pages: column-aligned STORM ID / DBZM HGT lines.
  const maxRef = new Map();
  for (const page of blocks.graphic) {
    const ids =
      page
        .find((l) => /^\s*STORM ID/.test(l))
        ?.replace(/^\s*STORM ID/, '')
        .trim()
        .split(/\s+/) ?? [];
    const dbz =
      page
        .find((l) => /^\s*DBZM HGT/.test(l))
        ?.replace(/^\s*DBZM HGT/, '')
        .trim()
        .split(/\s+/) ?? [];
    ids.forEach((id, k) => {
      const value = Number(dbz[2 * k]);
      const height = Number(dbz[2 * k + 1]);
      if (Number.isFinite(value))
        maxRef.set(id, {
          dbz: value,
          heightKft: Number.isFinite(height) ? height : null,
        });
    });
  }
  const cells = features(blocks.packets, 15).map(
    ({ packet, past, forecast, circle }) => {
      const { view, start } = packet;
      const at = pos(view, start);
      const id = String.fromCharCode(
        view.getUint8(start + 4),
        view.getUint8(start + 5),
      );
      const row = rows.get(id) ?? {};
      return {
        id,
        ...locate(site, at.i, at.j),
        motion: row.motion ?? null,
        isNew: row.isNew ?? !forecast.length,
        past: past.map((p) => locate(site, p.i, p.j)),
        forecast: forecast.map((p, k) => ({
          minutes: FORECAST_MINUTES[k] ?? (k + 1) * 15,
          ...locate(site, p.i, p.j),
        })),
        // Cells too new to forecast are drawn with a circle instead.
        circleKm: circle ? circle.radius * QUARTER_KM : null,
        errorNm: row.errorNm ?? null,
        maxReflectivity: maxRef.get(id) ?? null,
      };
    },
  );
  return {
    product: 'NST',
    productCode: 58,
    site,
    scanMs: blocks.scanMs,
    averageMotion: average,
    cells,
  };
}

/** Mesocyclone Detection (NMD, product 141). */
export function decodeMesocyclones(bytes) {
  const blocks = readLevel3Blocks(bytes);
  if (blocks.productCode !== 141)
    throw new Error(`expected product 141 (NMD), got ${blocks.productCode}`);
  const { site } = blocks;
  const rows = [];
  let average = null;
  for (const line of blocks.tabular.flat()) {
    const avg = /Avg dir\/spd:\s*(\d+)\/\s*(\d+)/.exec(line);
    if (avg) average = motionOf(avg[1], avg[2]);
    // CIRC AZRAN SR STM | LL RV DV BASE | DEPTH STMREL% | MAXRV kft kts | TVS MOTION MSI
    const m =
      /^\s+(\d+)\s+(\d+)\/\s*(\d+)\s+(\d+[LH]?)\s+([A-Z]\d|\?\?)\s+(\d+)\s+(\d+)\s+([<>]?\s*\d+)\s+([<>]?\s*\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([YN])\s+(?:(\d+)\/\s*(\d+))?\s*(\d+)\s*$/.exec(
        line,
      );
    if (!m) continue;
    rows.push({
      circulationId: m[1],
      azimuthDeg: Number(m[2]),
      rangeNm: Number(m[3]),
      strengthRank: m[4],
      stormId: m[5] === '??' ? null : m[5],
      lowLevel: {
        rotationalVelocityKt: Number(m[6]),
        deltaVelocityKt: Number(m[7]),
        baseKft: qualified(m[8]),
      },
      depthKft: qualified(m[9]),
      stormRelativeDepthPct: Number(m[10]),
      maxRotationalVelocity: { heightKft: Number(m[11]), kt: Number(m[12]) },
      tvs: m[13] === 'Y',
      motion: motionOf(m[14], m[15]),
      msi: Number(m[16]),
    });
  }
  const placed = features(blocks.packets, 20).map(
    ({ packet, past, forecast }) => {
      const { view, start } = packet;
      const at = pos(view, start);
      return {
        ...locate(site, at.i, at.j),
        featureType: view.getInt16(start + 4),
        radiusKm: view.getInt16(start + 6) * QUARTER_KM,
        past: past.map((p) => locate(site, p.i, p.j)),
        forecast: forecast.map((p) => locate(site, p.i, p.j)),
      };
    },
  );
  // Point features and table rows are in the same order; check each pairing
  // against the table's own azimuth/range before trusting it.
  const circulations = placed.map((feature, k) => {
    const row = rows[k];
    const agrees =
      row &&
      Math.abs(
        ((((feature.azimuthDeg - row.azimuthDeg) % 360) + 540) % 360) - 180,
      ) <= 3 &&
      Math.abs(feature.rangeKm / KM_PER_NM - row.rangeNm) <= 2;
    return agrees
      ? { ...feature, ...row, azimuthDeg: feature.azimuthDeg }
      : feature;
  });
  return {
    product: 'NMD',
    productCode: 141,
    site,
    scanMs: blocks.scanMs,
    averageMotion: average,
    circulations,
  };
}

/** Decode any supported attribute product by its code. */
export function decodeLevel3Attributes(bytes, product) {
  if (product === 'NST') return decodeStormTracks(bytes);
  if (product === 'NMD') return decodeMesocyclones(bytes);
  throw new Error(`unsupported attribute product ${product}`);
}
