import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  horizonOccluder,
  screenProjectedRotation,
  stabilizeScreenRotation,
} from './iconOrientation.js';

const equatorPosition = Cesium.Cartesian3.fromDegrees(0, 0, 0);

function sceneForScreenRotation(degrees) {
  const angle = Cesium.Math.toRadians(degrees);
  return {
    camera: {
      rightWC: new Cesium.Cartesian3(Math.cos(angle), 0, -Math.sin(angle)),
      upWC: new Cesium.Cartesian3(Math.sin(angle), 0, Math.cos(angle)),
    },
  };
}

function wrappedDelta(actual, expected) {
  return Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected));
}

test('camera-basis course projection stays correct through a full orbit', () => {
  for (const degrees of [0, 90, 179, 181, 220, 270, 359]) {
    const actual = screenProjectedRotation(
      sceneForScreenRotation(degrees),
      equatorPosition,
      0,
      null,
    );
    assert.ok(
      Math.abs(wrappedDelta(actual, Cesium.Math.toRadians(degrees))) < 1e-12,
      `expected ${degrees}° course projection, received ${Cesium.Math.toDegrees(actual)}°`,
    );
  }
});

test('off-center oblique contacts pin the documented perspective divergence', () => {
  // Camera looks obliquely toward the equator. Right is world-east; up and
  // forward are pitched 30° from the local tangent/normal pair.
  const pitch = Cesium.Math.toRadians(30);
  const right = new Cesium.Cartesian3(0, 1, 0);
  const up = new Cesium.Cartesian3(Math.sin(pitch), 0, Math.cos(pitch));
  const forward = new Cesium.Cartesian3(-Math.cos(pitch), 0, Math.sin(pitch));
  const basisRotation = screenProjectedRotation(
    { camera: { rightWC: right, upWC: up } },
    equatorPosition,
    0,
    null,
  );

  // Exact pinhole derivative for a contact 2 km right of center and 5 km in
  // front. North has a depth component under this oblique camera, so exact
  // projection turns slightly while the stable camera-basis result stays up.
  const contactX = 2000;
  const contactY = 0;
  const contactZ = 5000;
  const north = new Cesium.Cartesian3(0, 0, 1);
  const directionX = Cesium.Cartesian3.dot(north, right);
  const directionY = Cesium.Cartesian3.dot(north, up);
  const directionZ = Cesium.Cartesian3.dot(north, forward);
  const exactScreenX = directionX * contactZ - contactX * directionZ;
  const exactScreenUp = directionY * contactZ - contactY * directionZ;
  const exactRotation = Math.atan2(-exactScreenX, exactScreenUp);

  assert.ok(Math.abs(basisRotation) < 1e-12);
  assert.ok(
    Math.abs(wrappedDelta(exactRotation, basisRotation)) >
      Cesium.Math.toRadians(5),
  );
});

test('screen rotation holds sub-degree projection noise', () => {
  const previous = 1;
  assert.equal(
    stabilizeScreenRotation(previous, previous + (0.25 * Math.PI) / 180),
    previous,
  );
});

test('screen rotation accepts deliberate camera-orbit movement', () => {
  const previous = 1;
  const next = previous + (2 * Math.PI) / 180;
  assert.equal(stabilizeScreenRotation(previous, next), next);
});

test('screen rotation compares across the wrapped angle boundary', () => {
  const previous = Math.PI - (0.1 * Math.PI) / 180;
  const next = -Math.PI + (0.1 * Math.PI) / 180;
  assert.equal(stabilizeScreenRotation(previous, next), previous);
});

// --- Perspective projection through a real view-projection --------------------

import {
  PERSPECTIVE_BLEND_MAX_PX,
  PERSPECTIVE_BLEND_MIN_PX,
  PERSPECTIVE_PROBE_M,
  perspectiveProjectedRotation,
} from './iconOrientation.js';

/**
 * A scene the exact projector accepts: 3D mode, a canvas, and a camera with a
 * real view matrix and perspective frustum. The camera sits `altitudeM` above
 * the origin and looks north, pitched down by `pitchDeg`, with world east as
 * screen right — the oblique street-level pose where the camera-basis answer
 * is wrong off-centre and the exact one is not.
 */
function obliqueScene(
  altitudeM,
  pitchDeg,
  { width = 1280, height = 800 } = {},
) {
  const position = Cesium.Cartesian3.fromDegrees(0, 0, altitudeM);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const east = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian3());
  const north = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian3());
  const up = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian3());
  const pitch = Cesium.Math.toRadians(pitchDeg);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(
        north,
        Math.cos(pitch),
        new Cesium.Cartesian3(),
      ),
      Cesium.Cartesian3.multiplyByScalar(
        up,
        -Math.sin(pitch),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const cameraUp = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(
        north,
        Math.sin(pitch),
        new Cesium.Cartesian3(),
      ),
      Cesium.Cartesian3.multiplyByScalar(
        up,
        Math.cos(pitch),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const viewMatrix = Cesium.Matrix4.computeView(
    position,
    direction,
    cameraUp,
    east,
    new Cesium.Matrix4(),
  );
  const frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.toRadians(60),
    aspectRatio: width / height,
    near: 1,
    far: 1e7,
  });
  return {
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    canvas: { clientWidth: width, clientHeight: height },
    camera: {
      viewMatrix,
      frustum,
      rightWC: east,
      upWC: cameraUp,
      positionWC: position,
    },
  };
}

/** Probe separation (px) the helper sees for a contact and course in a scene. */
function probeSeparation(scene, contact, courseDeg) {
  const courseRad = Cesium.Math.toRadians(courseDeg);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(contact);
  const forward = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(
      Math.sin(courseRad) * PERSPECTIVE_PROBE_M,
      Math.cos(courseRad) * PERSPECTIVE_PROBE_M,
      0,
    ),
    new Cesium.Cartesian3(),
  );
  const probe = Cesium.Cartesian3.add(
    contact,
    forward,
    new Cesium.Cartesian3(),
  );
  const at = Cesium.SceneTransforms.worldToWindowCoordinates(scene, contact);
  const ahead = Cesium.SceneTransforms.worldToWindowCoordinates(scene, probe);
  const dx = ahead.x - at.x;
  const dy = ahead.y - at.y;
  return { separation: Math.hypot(dx, dy), exact: Math.atan2(-dx, -dy) };
}

test('the perspective helper is continuous through the sub-pixel band, not a 23° flip', () => {
  // Codex's reproduction: a contact near the right edge of an oblique view,
  // the camera altitude walked so the probe separation crosses half a pixel.
  // The rotation jumped 23° → 0° between two adjacent altitudes. The exact
  // and camera-basis answers now blend across a band, the short way round.
  //
  // The contact keeps the SAME screen position across the walk — its ground
  // offsets scale with the altitude — so the two answers disagree by the
  // same twenty-odd degrees at every altitude while the separation alone
  // walks from well above the band to well below it.
  const course = 0; // northbound
  const contactFor = (altitude) =>
    Cesium.Cartesian3.fromDegrees(
      (0.7 * altitude) / 111_320,
      (1.2 * altitude) / 111_320,
      0,
    );
  const samples = [];
  // Geometric steps: separation scales with altitude, so equal ratios give
  // equal-sized steps in the quantity the band is defined on.
  for (let altitude = 500; altitude <= 600_000; altitude *= 1.02) {
    const scene = obliqueScene(altitude, 45);
    const contact = contactFor(altitude);
    if (!Cesium.SceneTransforms.worldToWindowCoordinates(scene, contact))
      continue;
    const { separation, exact } = probeSeparation(scene, contact, course);
    samples.push({
      altitude,
      separation,
      exact,
      rotation: perspectiveProjectedRotation(scene, contact, course, null),
      basis: screenProjectedRotation(scene, contact, course, null),
    });
  }
  const inBand = samples.filter(
    (s) =>
      s.separation > PERSPECTIVE_BLEND_MIN_PX &&
      s.separation < PERSPECTIVE_BLEND_MAX_PX,
  );
  const above = samples.filter((s) => s.separation >= PERSPECTIVE_BLEND_MAX_PX);
  const below = samples.filter((s) => s.separation <= PERSPECTIVE_BLEND_MIN_PX);
  assert.ok(
    inBand.length >= 5 && above.length >= 5 && below.length >= 5,
    `the walk crosses the whole band (${below.length}/${inBand.length}/${above.length})`,
  );

  // Off-centre and oblique, the two answers genuinely disagree — that is the
  // divergence the exact projection exists to fix.
  const disagreement = Math.abs(
    wrappedDelta(above[0].rotation, above[0].basis),
  );
  assert.ok(
    disagreement > Cesium.Math.toRadians(5),
    `exact and camera-basis differ by ${Cesium.Math.toDegrees(disagreement).toFixed(1)}° above the band`,
  );

  let worstStep = 0;
  for (let i = 1; i < samples.length; i += 1) {
    worstStep = Math.max(
      worstStep,
      Math.abs(wrappedDelta(samples[i].rotation, samples[i - 1].rotation)),
    );
  }
  assert.ok(
    worstStep < Cesium.Math.toRadians(3),
    `no step between neighbouring altitudes exceeds 3° (worst ${Cesium.Math.toDegrees(worstStep).toFixed(2)}°)`,
  );
  // Below the band it is the camera-basis answer; above it the exact one, unblended.
  for (const s of below)
    assert.ok(
      Math.abs(wrappedDelta(s.rotation, s.basis)) < 1e-6,
      `basis alone at ${s.separation.toFixed(2)} px`,
    );
  for (const s of above)
    assert.ok(
      Math.abs(wrappedDelta(s.rotation, s.exact)) < 1e-6,
      `exact alone at ${s.separation.toFixed(2)} px`,
    );
});
