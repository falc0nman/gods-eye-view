import { HC_COLORS, LEVEL3_COLOR_STOPS } from './data/level3Render.js';

/**
 * Radar colour legend (bottom centre, above the command dock).
 *
 * Built from the SAME colour tables the server renders with
 * (src/data/level3Render.js), so the legend cannot drift from the image.
 * Stops are drawn evenly spaced rather than to scale: the tables are
 * deliberately non-linear (CC packs most of its detail into 0.9–1.0), and an
 * even bar keeps every labelled step readable. Velocity is labelled in knots,
 * as chase apps do; the source data is m/s.
 */

const KT_PER_MS = 1.943844;
const RF_COLOR = '#8000a0';

const SCALES = Object.freeze({
  ref: { title: 'Reflectivity', unit: 'dBZ' },
  vel: { title: 'Base velocity', unit: 'kt', toLabel: (v) => Math.round(v * KT_PER_MS), sign: true, rf: true },
  srv: { title: 'Storm-relative velocity', unit: 'kt', sign: true, rf: true },
  cc: { title: 'Correlation coefficient', unit: 'ρhv', rf: true },
  zdr: { title: 'Differential reflectivity', unit: 'dB', rf: true },
  kdp: { title: 'Specific differential phase', unit: '°/km', rf: true },
  vil: { title: 'Vertically integrated liquid', unit: 'kg/m²' },
  et: { title: 'Echo tops', unit: 'kft' },
});

export const HC_NAMES = Object.freeze({
  BI: 'Biological', GC: 'Ground clutter', IC: 'Ice crystals', DS: 'Dry snow', WS: 'Wet snow',
  RA: 'Rain', HR: 'Heavy rain', BD: 'Big drops', GR: 'Graupel', HA: 'Hail + rain',
  LH: 'Large hail', GH: 'Giant hail',
});

function formatTick(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

/**
 * What the legend shows for a product. Pure.
 * @param {string} product nexrad layer product id (`composite`, `ref`, `vel`, …).
 * @param {{elevationDeg?: number|null}} [context]
 * @returns {null|{title: string, subtitle: string|null, unit: string|null, note: string|null,
 *   gradient: string|null, ticks: string[], classes: Array<{label: string, color: string}>,
 *   rangeFolded: boolean, signHint: boolean}}
 */
export function radarLegendModel(product, { elevationDeg = null } = {}) {
  const group = product === 'composite' ? 'ref' : product;
  const elev = Number.isFinite(elevationDeg) ? `${elevationDeg.toFixed(1)}° tilt` : null;
  if (group === 'hc') {
    return {
      title: 'Hydrometeor class',
      subtitle: elev,
      unit: null,
      note: null,
      gradient: null,
      ticks: [],
      classes: Object.entries(HC_NAMES).map(([code, label]) => ({ label, color: HC_COLORS[code] })),
      rangeFolded: false,
      signHint: false,
    };
  }
  const scale = SCALES[group];
  const stops = LEVEL3_COLOR_STOPS[group];
  if (!scale || !stops) return null;
  const last = stops.length - 1;
  const gradient = `linear-gradient(to right, ${stops
    .map(([, color], i) => `${color} ${((i / last) * 100).toFixed(1)}%`).join(', ')})`;
  const toLabel = scale.toLabel ?? ((v) => v);
  return {
    title: product === 'composite' ? 'Reflectivity · national composite' : scale.title,
    subtitle: product === 'composite' ? null : elev,
    unit: scale.unit,
    // IEM paints the composite with its own palette; ours is the same NWS-style ramp.
    note: product === 'composite' ? 'IEM colours, approximately this scale' : null,
    gradient,
    ticks: stops.map(([value]) => formatTick(toLabel(value))),
    classes: [],
    rangeFolded: Boolean(scale.rf),
    signHint: Boolean(scale.sign),
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * The legend element. Created lazily on first show, so importing this module
 * (e.g. from Node tests via the radar layer) never touches the DOM.
 */
export function createRadarLegend({ documentRef = globalThis.document } = {}) {
  let root = null;
  let lastKey = '';

  return {
    show(model) {
      if (!documentRef?.body || !model) return this.hide();
      const key = JSON.stringify(model);
      if (root && key === lastKey) {
        root.hidden = false;
        return;
      }
      lastKey = key;
      root ??= documentRef.body.appendChild(el('div', 'radar-legend'));
      root.setAttribute('role', 'img');
      root.setAttribute('aria-label', `${model.title} colour scale${model.unit ? ` in ${model.unit}` : ''}`);
      root.replaceChildren();
      const head = el('div', 'radar-legend-head');
      head.append(el('span', 'radar-legend-title', model.title));
      if (model.subtitle) head.append(el('span', 'radar-legend-sub', model.subtitle));
      if (model.unit) head.append(el('span', 'radar-legend-unit', model.unit));
      root.append(head);

      if (model.gradient) {
        const bar = el('div', 'radar-legend-bar');
        bar.style.background = model.gradient;
        const ticks = el('div', 'radar-legend-ticks');
        // Crowded scales label every other stop; the ends always stay labelled.
        const every = model.ticks.length > 10 ? 2 : 1;
        model.ticks.forEach((tick, i) => {
          const keep = i % every === 0 || i === model.ticks.length - 1;
          const span = el('span', null, keep ? tick : '');
          span.style.left = `${(i / (model.ticks.length - 1)) * 100}%`;
          ticks.append(span);
        });
        root.append(bar, ticks);
      }
      if (model.classes.length) {
        const grid = el('div', 'radar-legend-classes');
        for (const c of model.classes) {
          const item = el('span', 'radar-legend-class');
          const swatch = el('i');
          swatch.style.background = c.color;
          item.append(swatch, el('span', null, c.label));
          grid.append(item);
        }
        root.append(grid);
      }
      const foot = [];
      if (model.signHint) foot.push(el('span', null, '← toward radar · away →'));
      if (model.rangeFolded) {
        const rf = el('span', 'radar-legend-rf');
        const swatch = el('i');
        swatch.style.background = RF_COLOR;
        rf.append(swatch, el('span', null, 'range folded'));
        foot.push(rf);
      }
      if (model.note) foot.push(el('span', 'radar-legend-note', model.note));
      if (foot.length) {
        const footer = el('div', 'radar-legend-foot');
        footer.append(...foot);
        root.append(footer);
      }
      root.hidden = false;
    },
    hide() {
      if (root) root.hidden = true;
    },
    destroy() {
      root?.remove();
      root = null;
      lastKey = '';
    },
  };
}
