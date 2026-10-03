/**
 * Shared icon-orientation + horizon helpers. Orientation served the removed
 * moving-entity layers; the horizon occluder still serves CCTV and Radio.
 *
 * THE ORIENTATION PROBLEM (2026-06-10 playtest): billboards are camera-facing
 * quads, so "point along the real-world course" must be computed in SCREEN
 * space. The previous approach mixed two regimes (surface-normal alignedAxis
 * at oblique pitch, camera-heading compensation at nadir) and broke in
 * tracked-entity orbit mode, where camera.heading is expressed in the
 * entity's reference frame — the tracked icon stayed glued to the viewport.
 *
 * THE FIX: transform the local course vector into world space, then project it
 * directly onto the camera's right/up basis. This stays valid when a forward
 * probe point would be off-screen or behind the camera during a >180° tracked
 * orbit. The camera-basis projection is exact at the viewport center and an
 * intentional orthographic approximation elsewhere: an off-center contact at
 * oblique pitch can diverge from a pinhole/window-space projection because the
 * latter also includes the course vector's depth component. The approximation
 * keeps rotation continuous through tracked orbits; field evidence, not an
 * unverified math swap, decides whether exact projection becomes preferred.
 */
import * as Cesium from 'cesium';

/** Meters used to give the course vector a stable projection magnitude. */
const FORWARD_PROBE_M = 2000;
/**
 * Minimum camera-plane component before we trust the angle — below this the
 * course points almost exactly into/out of the screen and the angle is noise.
 */
const MIN_SCREEN_COMPONENT_M = 0.5;
/** Ignore sub-degree projection noise while retaining deliberate camera-orbit rotation. */
const ROTATION_DEADBAND_RAD = Cesium.Math.toRadians(0.5);

const _scratchEnu = new Cesium.Matrix4();
const _scratchForward = new Cesium.Cartesian3();
const _scratchWorldForward = new Cesium.Cartesian3();

/**
 * Computes the billboard rotation (radians, CCW-positive, for
 * alignedAxis = Cartesian3.ZERO) that points an icon along its real-world
 * course in the stable camera-basis approximation described above.
 *
 * @param {Cesium.Scene} scene - The scene (projection source).
 * @param {Cesium.Cartesian3} position - Entity world position.
 * @param {number} courseDeg - Course/track in degrees clockwise from north.
 * @param {number|null} previous - Rotation to keep when projection is
 *   unavailable (off-screen/behind camera/degenerate).
 * @returns {number|null} Rotation in radians, or `previous` when unknown.
 */
export function screenProjectedRotation(
  scene,
  position,
  courseDeg,
  previous = null,
) {
  const camera = scene?.camera;
  if (!camera?.rightWC || !camera?.upWC || !position) return previous;

  const courseRad = Cesium.Math.toRadians(courseDeg || 0);
  Cesium.Cartesian3.fromElements(
    Math.sin(courseRad) * FORWARD_PROBE_M,
    Math.cos(courseRad) * FORWARD_PROBE_M,
    0,
    _scratchForward,
  );
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    position,
    Cesium.Ellipsoid.WGS84,
    _scratchEnu,
  );
  Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    _scratchForward,
    _scratchWorldForward,
  );

  // Screen x follows camera-right. Window y grows downward, the opposite of
  // camera-up. Projecting the vector itself avoids clipping/behind-camera
  // failure modes from the old forward-point worldToWindowCoordinates probe.
  const dx = Cesium.Cartesian3.dot(_scratchWorldForward, camera.rightWC);
  const dy = -Cesium.Cartesian3.dot(_scratchWorldForward, camera.upWC);
  if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_M * MIN_SCREEN_COMPONENT_M)
    return previous;

  // Window y grows downward; rotation 0 = icon pointing screen-up.
  // Icon direction in window coords after CCW rotation r is (-sin r, -cos r),
  // so matching the projected course (dx, dy) gives r = atan2(-dx, -dy).
  return Math.atan2(-dx, -dy);
}

/**
 * Hold a billboard rotation when the newly projected angle differs only by
 * sub-degree render noise. The comparison uses the shortest wrapped arc so
 * values around ±π do not jump.
 *
 * @param {number|null} previous Last displayed rotation.
 * @param {number|null} next Newly projected rotation.
 * @param {number} [deadbandRad=ROTATION_DEADBAND_RAD] Angular hold threshold.
 * @returns {number|null} Stable rotation.
 */
export function stabilizeScreenRotation(
  previous,
  next,
  deadbandRad = ROTATION_DEADBAND_RAD,
) {
  if (!Number.isFinite(next))
    return Number.isFinite(previous) ? previous : null;
  if (!Number.isFinite(previous)) return next;
  const delta = Math.atan2(
    Math.sin(next - previous),
    Math.cos(next - previous),
  );
  return Math.abs(delta) < Math.max(0, deadbandRad) ? previous : next;
}

const _occluder = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  new Cesium.Cartesian3(),
);

/**
 * Returns the shared horizon occluder, updated to the camera's position.
 * With the Cesium globe hidden (Google 3D tiles provide the planet) nothing
 * writes far-side depth, so billboards must be horizon-culled manually.
 * Call once per tick, then test points with occluder.isPointVisible(pos).
 *
 * @param {Cesium.Camera} camera - The scene camera.
 * @returns {Cesium.EllipsoidalOccluder}
 */
export function horizonOccluder(camera) {
  _occluder.cameraPosition = camera.positionWC;
  return _occluder;
}

/**
 * Cheap camera pose signature for "did the camera move" gating of rotation
 * passes (position quantized to ~10m, angles to ~0.06 deg).
 * @param {Cesium.Camera} camera - The scene camera.
 * @returns {string}
 */
export function cameraPoseSignature(camera) {
  const p = camera.positionWC;
  return (
    `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}:${Math.round(p.z / 10)}:` +
    `${camera.heading.toFixed(3)}:${camera.pitch.toFixed(3)}:${camera.roll.toFixed(3)}`
  );
}

/**
 * Meters ahead used by the exact projection below. Short on purpose: the point
 * of a perspective projection is that it is LOCAL to the contact, and a two
 * kilometre probe on a bus at six hundred metres would sample a part of the
 * frustum the vehicle is nowhere near.
 */
const NEAR_PROBE_M = 30;
const _scratchProbe = new Cesium.Cartesian3();
const _scratchWindowAt = new Cesium.Cartesian2();
const _scratchWindowAhead = new Cesium.Cartesian2();

/**
 * Billboard rotation for a SURFACE contact, projected exactly — perspective
 * division included — instead of through the camera-basis approximation.
 *
 * `screenProjectedRotation` above deliberately projects the course vector onto
 * the camera's right/up basis, which is orthographic: exact at the viewport
 * centre and an approximation away from it. That is the right trade for
 * aircraft, where the alternative loses continuity through a tracked orbit and
 * the contacts are far enough away for the error to be small.
 *
 * It is the wrong trade for street-level vehicles. A probe with a real Cesium
 * camera at 600 m and −45° pitch, on a northbound contact 350 m right of
 * centre, put the orthographic answer at 0° where the true screen direction of
 * travel was 22.5°. At that pitch and that range the vehicles fill the frame
 * away from the centre, and every one of them points visibly wrong.
 *
 * So this projects two nearby world points through the actual view-projection
 * and reads the angle between them on screen. When either point cannot be
 * projected — behind the camera, off the frustum, degenerate — it falls back to
 * the camera-basis answer rather than inventing one.
 *
 * @param {Cesium.Scene} scene The scene (projection source).
 * @param {Cesium.Cartesian3} position Entity world position.
 * @param {number} courseDeg Course in degrees clockwise from north.
 * @param {number|null} previous Rotation to keep when projection is unavailable.
 * @returns {number|null} Rotation in radians, or the fallback.
 */
export function perspectiveProjectedRotation(
  scene,
  position,
  courseDeg,
  previous = null,
) {
  if (!scene?.camera || !position || !Number.isFinite(courseDeg)) {
    return previous;
  }
  const courseRad = Cesium.Math.toRadians(courseDeg);
  Cesium.Cartesian3.fromElements(
    Math.sin(courseRad) * NEAR_PROBE_M,
    Math.cos(courseRad) * NEAR_PROBE_M,
    0,
    _scratchForward,
  );
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    position,
    Cesium.Ellipsoid.WGS84,
    _scratchEnu,
  );
  Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    _scratchForward,
    _scratchWorldForward,
  );
  Cesium.Cartesian3.add(position, _scratchWorldForward, _scratchProbe);

  const at = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    _scratchWindowAt,
  );
  const ahead = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    _scratchProbe,
    _scratchWindowAhead,
  );
  if (!at || !ahead) {
    return screenProjectedRotation(scene, position, courseDeg, previous);
  }
  const dx = ahead.x - at.x;
  const dy = ahead.y - at.y;
  const separation = Math.hypot(dx, dy);
  // Window y grows downward; rotation 0 = icon pointing screen-up.
  const exact = Math.atan2(-dx, -dy);
  if (separation >= PERSPECTIVE_BLEND_MAX_PX) return exact;
  // Below a pixel or so of separation the exact answer is dominated by
  // projection noise, and above it the camera-basis answer is the wrong one
  // by up to twenty-odd degrees. A hard cutoff between the two flipped a
  // sprite by 23° for a 20 m change of camera altitude; the two answers are
  // blended across the band instead, the short way round, so the rotation is
  // continuous through it.
  const basis = screenProjectedRotation(scene, position, courseDeg, previous);
  if (!Number.isFinite(basis)) return exact;
  if (separation <= PERSPECTIVE_BLEND_MIN_PX) return basis;
  const weight =
    (separation - PERSPECTIVE_BLEND_MIN_PX) /
    (PERSPECTIVE_BLEND_MAX_PX - PERSPECTIVE_BLEND_MIN_PX);
  const delta = Math.atan2(Math.sin(exact - basis), Math.cos(exact - basis));
  return basis + delta * weight;
}

/**
 * Probe separations (px) between which the exact and camera-basis answers
 * are blended. At or below the floor the camera-basis answer is used alone;
 * at or above the ceiling the exact one.
 */
export const PERSPECTIVE_BLEND_MIN_PX = 0.5;
export const PERSPECTIVE_BLEND_MAX_PX = 3;

/** Exported for tests: how far ahead the exact projection probes. */
export const PERSPECTIVE_PROBE_M = NEAR_PROBE_M;
