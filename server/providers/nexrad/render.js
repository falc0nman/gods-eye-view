/**
 * Level III radials → a map image — SERVER-SIDE.
 *
 * Renders a decoded product (./level3.js) into an RGBA image in plain
 * latitude/longitude (equirectangular) projection over the radar's coverage
 * square, which is exactly what Cesium's SingleTileImageryProvider drapes, and
 * encodes it as PNG. Pure: zlib's deflate and crc32 are injected.
 *
 * Colour comes from a 256-entry table built once per product (a radial gate
 * holds one byte), so the per-pixel work is one range/azimuth lookup.
 */

import { colorForValue } from '../../../src/layers/nexrad/palette.js';

/** Coverage square around the radar, in degrees. */
export function coverageBounds(site, rangeKm) {
  const latSpan = rangeKm / 111.2;
  const lonSpan =
    rangeKm / (111.32 * Math.max(0.2, Math.cos((site.lat * Math.PI) / 180)));
  return {
    west: site.lon - lonSpan,
    south: Math.max(-85, site.lat - latSpan),
    east: site.lon + lonSpan,
    north: Math.min(85, site.lat + latSpan),
  };
}

/**
 * Render a decoded product.
 * @param {ReturnType<import('./level3.js').decodeLevel3>} product
 * @param {{maxSize?: number}} [options]
 * @returns {{width: number, height: number, rgba: Uint8Array, bounds: object, rangeKm: number}}
 */
export function renderLevel3(product, { maxSize = 2048 } = {}) {
  const rangeKm = (product.firstBin + product.bins) * product.gateKm;
  const bounds = coverageBounds(product.site, rangeKm);
  // About one pixel per gate (never finer than 300 m), capped.
  const size = Math.max(
    256,
    Math.min(maxSize, Math.ceil((2 * rangeKm) / Math.max(product.gateKm, 0.3))),
  );
  const width = size;
  const height = size;
  const rgba = new Uint8Array(width * height * 4);

  const lut = new Array(256);
  for (let level = 0; level < 256; level += 1)
    lut[level] = colorForValue(product.group, product.valueOf(level));

  // Azimuth (0.1° buckets) → radial index.
  const azIndex = new Int32Array(3600).fill(-1);
  product.radials.forEach((radial, index) => {
    const from = Math.round(radial.start * 10);
    const span = Math.max(1, Math.round(radial.delta * 10));
    for (let k = 0; k < span; k += 1)
      azIndex[(((from + k) % 3600) + 3600) % 3600] = index;
  });

  const R = 6371;
  const rad = Math.PI / 180;
  const lat0 = product.site.lat;
  const lon0 = product.site.lon;
  const lonStep = (bounds.east - bounds.west) / width;
  const latStep = (bounds.north - bounds.south) / height;
  const gateScale = 1 / product.gateKm;
  for (let y = 0; y < height; y += 1) {
    const lat = bounds.north - (y + 0.5) * latStep;
    const dy = (lat - lat0) * rad * R;
    const kmPerLon = Math.cos(lat * rad) * rad * R;
    for (let x = 0; x < width; x += 1) {
      const dx = (bounds.west + (x + 0.5) * lonStep - lon0) * kmPerLon;
      const rangeK = Math.sqrt(dx * dx + dy * dy);
      if (rangeK >= rangeKm) continue;
      const gate = Math.floor(rangeK * gateScale) - product.firstBin;
      if (gate < 0) continue;
      let az = Math.atan2(dx, dy) / rad;
      if (az < 0) az += 360;
      const radialIndex = azIndex[Math.floor(az * 10) % 3600];
      if (radialIndex < 0) continue;
      const level = product.radials[radialIndex].levels[gate];
      const color = level === undefined ? null : lut[level];
      if (!color) continue;
      const o = (y * width + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = color[3];
    }
  }
  return { width, height, rgba, bounds, rangeKm };
}

/**
 * Minimal RGBA PNG encoder.
 * @param {{width: number, height: number, rgba: Uint8Array}} image
 * @param {{deflate: (data: Uint8Array) => Uint8Array, crc32: (data: Uint8Array) => number}} zlib
 * @returns {Uint8Array}
 */
export function encodePng({ width, height, rgba }, { deflate, crc32 }) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(
      8 + body.length,
      crc32(out.subarray(4, 8 + body.length)) >>> 0,
    );
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}
