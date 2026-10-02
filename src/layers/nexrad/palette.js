/**
 * NEXRAD Level III colour tables — shared by the server renderer
 * (server/providers/nexrad/render.js) and the browser legend
 * (src/layers/nexrad/legend.js), so the legend cannot drift from the image.
 * Pure; no imports.
 */

export const RF_COLOR = [128, 0, 160, 255];

/** Value → colour stops per display group (chaser-app conventions). */
export const LEVEL3_COLOR_STOPS = Object.freeze({
  ref: [
    [5, '#04e9e7'],
    [10, '#019ff4'],
    [15, '#0300f4'],
    [20, '#02fd02'],
    [25, '#01c501'],
    [30, '#008e00'],
    [35, '#fdf802'],
    [40, '#e5bc00'],
    [45, '#fd9500'],
    [50, '#fd0000'],
    [55, '#d40000'],
    [60, '#bc0000'],
    [65, '#f800fd'],
    [70, '#9854c6'],
    [75, '#fdfdfd'],
  ],
  vel: [
    [-60, '#c8ffff'],
    [-40, '#00ff00'],
    [-20, '#00a000'],
    [-5, '#2d5a2d'],
    [-1, '#606060'],
    [1, '#606060'],
    [5, '#5a2d2d'],
    [20, '#a00000'],
    [40, '#ff0000'],
    [60, '#ffc8c8'],
  ],
  // Storm-relative velocity is in knots.
  srv: [
    [-120, '#c8ffff'],
    [-64, '#00ff00'],
    [-36, '#00a000'],
    [-10, '#2d5a2d'],
    [-1, '#606060'],
    [1, '#606060'],
    [10, '#5a2d2d'],
    [36, '#a00000'],
    [64, '#ff0000'],
    [120, '#ffc8c8'],
  ],
  cc: [
    [0.2, '#1a0d4d'],
    [0.45, '#3a2aa8'],
    [0.65, '#2f8fd8'],
    [0.8, '#38c16a'],
    [0.9, '#e8e83a'],
    [0.95, '#f58a2a'],
    [0.98, '#e02b2b'],
    [1.0, '#c31a7a'],
    [1.05, '#f0c0f0'],
  ],
  zdr: [
    [-4, '#404040'],
    [-1, '#9a9a9a'],
    [0, '#d8d8d8'],
    [0.5, '#1e3cff'],
    [1, '#00b0ff'],
    [2, '#00e070'],
    [3, '#f0f000'],
    [4, '#ff9000'],
    [5, '#ff0000'],
    [6, '#c00060'],
    [8, '#ffffff'],
  ],
  kdp: [
    [-2, '#404040'],
    [0, '#a0a0a0'],
    [0.5, '#00c0ff'],
    [1, '#00e070'],
    [2, '#f0f000'],
    [3, '#ff9000'],
    [4, '#ff0000'],
    [7, '#ff80ff'],
  ],
  vil: [
    [1, '#04e9e7'],
    [5, '#019ff4'],
    [10, '#02fd02'],
    [20, '#008e00'],
    [30, '#fdf802'],
    [40, '#fd9500'],
    [50, '#fd0000'],
    [60, '#bc0000'],
    [70, '#f800fd'],
    [80, '#ffffff'],
  ],
  et: [
    [5, '#3a6ed8'],
    [15, '#38c1d8'],
    [25, '#38c16a'],
    [35, '#e8e83a'],
    [45, '#f58a2a'],
    [55, '#e02b2b'],
    [65, '#f800fd'],
    [70, '#ffffff'],
  ],
});

/** Hydrometeor classes → colour. */
export const HC_COLORS = Object.freeze({
  BI: '#b4b4b4',
  GC: '#8b5a2b',
  IC: '#ff9fd0',
  DS: '#7fbfff',
  WS: '#2050ff',
  RA: '#60e060',
  HR: '#108010',
  BD: '#f0f000',
  GR: '#ff9900',
  HA: '#ff0000',
  LH: '#b00030',
  GH: '#ff00ff',
});

function hex(color) {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/** Interpolated colour for a value, or null below the first stop. */
export function colorForValue(group, value) {
  if (value === 'RF') return RF_COLOR;
  if (typeof value === 'string')
    return HC_COLORS[value] ? hex(HC_COLORS[value]) : null;
  if (!Number.isFinite(value)) return null;
  const stops = LEVEL3_COLOR_STOPS[group];
  if (!stops) return null;
  // Velocity tables cover both signs; everything else starts at its first stop.
  if (value < stops[0][0])
    return group === 'vel' || group === 'srv' ? hex(stops[0][1]) : null;
  for (let i = 1; i < stops.length; i += 1) {
    const [v1, c1] = stops[i];
    if (value <= v1) {
      const [v0, c0] = stops[i - 1];
      const t = (value - v0) / (v1 - v0 || 1);
      const a = hex(c0);
      const b = hex(c1);
      return [0, 1, 2]
        .map((k) => Math.round(a[k] + (b[k] - a[k]) * t))
        .concat(255);
    }
  }
  return hex(stops.at(-1)[1]);
}
