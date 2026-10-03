// src/scenes/scenePolicy.js — pure decisions for cinematic scene playback.
//
// The scene director was written when the app shipped four data layers, and its
// shot recipes (src/scenes/recipes.js) still declare exactly those four:
// flights, satellites, earthquakes, traffic. The registry has since grown to
// sixteen. The original reconcile walked the LIVE registry and forced every
// layer absent from the shot to off, so a recipe that never had an opinion
// about CCTV, vessels, fires, radio, cables, dams or datacenters silently tore
// them down — and nothing puts them back, because playback has no restore pass.
//
// A shot's layer map is an assertion about the layers it NAMES, not a claim of
// authority over every layer that will ever exist. Recipes already spell out
// the layers they want OFF (see 'thermal-threats', which declares
// flights/satellites/traffic false), so honouring only the declared keys keeps
// every authored intent intact while leaving undeclared layers alone.
//
// Operator-captured shots are unaffected: captureShot() snapshots the whole
// registry (director._captureLayerStates), so those shots declare all sixteen
// keys and still reconcile in full.

/**
 * Selection-shaped layer params that playback deliberately KEEPS.
 *
 * `selectedCameraId` (cctv) activates a camera and raises its monitor plane.
 * It never writes viewer.trackedEntity or moves the camera — only the separate
 * `focusSelected` option does that — so it is composition the operator meant
 * to capture, not a second writer on the camera. The vessels layer exposes no
 * getParams() surface at all, so its selection cannot be captured today.
 *
 * The list exists so the decision is RECORDED rather than implied by absence:
 * scenePolicy.test.mjs sweeps every layer's getParams() for the selection
 * naming family and requires each match to appear on this list. A future
 * param that re-establishes a tracked contact (and with it a second writer on
 * the camera) therefore fails that test until playback is taught to strip it;
 * the flight layers' stripping went with them in GW-57.
 * @constant {ReadonlyArray<string>}
 */
export const SCENE_KEPT_SELECTION_PARAM_KEYS = Object.freeze([
  'selectedCameraId',
]);

/**
 * Names belonging to the selection/tracking family, whatever their spelling.
 * Deliberately wider than the params that exist today — the sweep's job is to
 * force a decision about a NEW name, not to recognise the current ones.
 * @constant {RegExp}
 */
export const SCENE_SELECTION_PARAM_PATTERN =
  /^(?:selected|tracked)[A-Z0-9]|TrackingId$|(?:Mmsi|Norad|Icao|Callsign)$/;

/**
 * Build the ordered layer reconcile plan for one shot.
 *
 * Only layers the shot explicitly declares are touched. Declared layers that
 * are no longer registered (an imported or long-stored project referencing a
 * retired layer) are skipped rather than pushed at the data manager.
 *
 * @param {Object.<string, { enabled: boolean, params?: Object }>} targetStates
 *   The shot's normalized layer map.
 * @param {Set<string>|Iterable<string>} [registeredIds] Layer ids the data
 *   manager currently knows about. Omit to skip the registration filter.
 * @returns {Array<{ id: string, enabled: boolean, params: Object|undefined }>}
 */
export function sceneLayerPlan(targetStates, registeredIds) {
  const known =
    registeredIds instanceof Set
      ? registeredIds
      : registeredIds
        ? new Set(registeredIds)
        : null;

  const plan = [];
  for (const [id, target] of Object.entries(targetStates || {})) {
    if (known && !known.has(id)) continue;
    plan.push({
      id,
      enabled: !!(target && target.enabled),
      params:
        target?.params && typeof target.params === 'object'
          ? target.params
          : undefined,
    });
  }
  return plan;
}
