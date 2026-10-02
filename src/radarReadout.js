import * as Cesium from 'cesium';
import { HC_NAMES } from './radarLegend.js';

/**
 * Cursor readout for single-radar products: the decoded value under the
 * pointer, its distance from the radar, and the beam height there.
 *
 * The browser only has the rendered image, so values come from the server,
 * which keeps every decoded scan (`/api/radar/l3/value`). Pointer moves are
 * throttled and only the newest request is shown, so a fast sweep across the
 * map costs a handful of tiny requests, not hundreds.
 */

const KT_PER_MS = 1.943844;
const THROTTLE_MS = 90;

/**
 * Human value for a product group. Velocity reads in knots with direction.
 * @returns {string|null}
 */
export function formatRadarValue(group, value) {
  if (value === null || value === undefined) return null;
  if (value === 'RF') return 'Range folded';
  if (typeof value === 'string') return HC_NAMES[value] ?? value;
  if (!Number.isFinite(value)) return null;
  const velocity = (kt) => {
    const rounded = Math.round(kt);
    if (rounded === 0) return '0 kt';
    return `${Math.abs(rounded)} kt ${rounded < 0 ? 'toward' : 'away'}`;
  };
  switch (group) {
    case 'ref': return `${value.toFixed(1)} dBZ`;
    case 'vel': return velocity(value * KT_PER_MS);
    case 'srv': return velocity(value);
    case 'cc': return value.toFixed(2);
    case 'zdr': return `${value.toFixed(1)} dB`;
    case 'kdp': return `${value.toFixed(2)} °/km`;
    case 'vil': return `${value.toFixed(0)} kg/m²`;
    case 'et': return `${value.toFixed(0)} kft`;
    default: return String(value);
  }
}

/** `87 km · beam 6,200 ft` (miles alongside km, as chasers read range). */
export function formatRadarContext(hit) {
  const parts = [];
  if (Number.isFinite(hit?.rangeKm)) parts.push(`${Math.round(hit.rangeKm)} km / ${Math.round(hit.rangeKm * 0.621371)} mi`);
  if (Number.isFinite(hit?.beamHeightFt)) parts.push(`beam ${hit.beamHeightFt.toLocaleString('en-US')} ft`);
  return parts.join(' · ');
}

/**
 * @param {{viewer: Cesium.Viewer, getTarget: () => ({key: string, group: string}|null),
 *   fetchImpl?: Function}} options `getTarget` returns the scan on screen, or null
 *   when there is nothing to read (layer off, composite, no radar).
 */
export function createRadarReadout({ viewer, getTarget, fetchImpl = (...args) => fetch(...args) }) {
  const canvas = viewer?.scene?.canvas;
  let tip = null;
  let lastSent = 0;
  let pending = null;
  let controller = null;
  let latestPointer = null;

  const hide = () => {
    if (tip) tip.hidden = true;
  };
  const place = (x, y) => {
    if (!tip) return;
    // Keep the tip on screen near the right/bottom edges.
    const flipX = x > window.innerWidth - 220;
    const flipY = y > window.innerHeight - 80;
    tip.style.left = `${flipX ? x - 14 : x + 14}px`;
    tip.style.top = `${flipY ? y - 14 : y + 14}px`;
    tip.style.transform = `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`;
  };

  const lookup = async () => {
    pending = null;
    lastSent = performance.now();
    const target = getTarget();
    const pointer = latestPointer;
    if (!target || !pointer) return hide();
    const rect = canvas.getBoundingClientRect();
    const hit = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(pointer.x - rect.left, pointer.y - rect.top));
    if (!hit) return hide();
    const carto = Cesium.Cartographic.fromCartesian(hit);
    const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(4);
    const lon = Cesium.Math.toDegrees(carto.longitude).toFixed(4);
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetchImpl(`/api/radar/l3/value?key=${target.key}&lat=${lat}&lon=${lon}`, {
        signal: controller.signal,
      });
      if (!response.ok) return hide();
      const result = await response.json();
      if (pointer !== latestPointer || getTarget()?.key !== target.key) return; // superseded
      const value = formatRadarValue(target.group, result.value);
      if (!result.inRange || !value) return hide();
      tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'radar-readout' }));
      tip.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = value;
      const small = document.createElement('span');
      small.textContent = formatRadarContext(result);
      tip.append(strong, small);
      tip.hidden = false;
      place(pointer.x, pointer.y);
    } catch (error) {
      if (error?.name !== 'AbortError') hide();
    }
  };

  const onMove = (event) => {
    latestPointer = { x: event.clientX, y: event.clientY };
    if (tip && !tip.hidden) place(latestPointer.x, latestPointer.y);
    if (!getTarget()) return hide();
    if (pending) return;
    const wait = Math.max(0, THROTTLE_MS - (performance.now() - lastSent));
    pending = setTimeout(lookup, wait);
  };
  const onLeave = () => {
    latestPointer = null;
    controller?.abort();
    hide();
  };

  canvas?.addEventListener('pointermove', onMove);
  canvas?.addEventListener('pointerleave', onLeave);
  return {
    hide,
    destroy() {
      canvas?.removeEventListener('pointermove', onMove);
      canvas?.removeEventListener('pointerleave', onLeave);
      clearTimeout(pending);
      controller?.abort();
      tip?.remove();
      tip = null;
    },
  };
}
