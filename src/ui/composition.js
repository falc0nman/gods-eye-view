/** Compose UI controls with the application's existing engines and layer instances. */
import { StyleManager as ApplicationShell } from './applicationShell.js';
import { LocationSearch } from './location.js';
import {
  CITY_POIS,
  GLOBE_VIEW,
  flyToGlobeView,
  flyToPresetLocation,
  flyToPOI,
  searchAndFlyTo,
} from '../locations.js';
import { interruptCameraMotion } from '../cameraVerbs.js';
import { IntelHUD } from '../hud.js';
import { ShareLinkManager } from '../sharelink.js';
import { OrbitController } from '../orbit.js';
import {
  CelestialRing,
  getKeyholeFadeTuning,
  isCelestialRingStyleSupported,
  setKeyholeFadeTuning,
} from '../celestialRing.js';
import {
  destroyWorldOverlay,
  initWorldOverlay,
} from '../overlays/worldOverlay.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';
import {
  setScopeMaskEnabled,
  isScopeMaskEnabled,
  setScopeMaskFeather,
  getScopeMaskFeather,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  clampScopeTerminusPct,
} from '../scopeMask.js';

export class StyleManager extends ApplicationShell {
  constructor(viewer, options = {}) {
    super(viewer, {
      ...options,
      services: {
        CITY_POIS,
        GLOBE_VIEW,
        flyToGlobeView,
        flyToPresetLocation,
        flyToPOI,
        searchAndFlyTo,
        interruptCameraMotion,
        IntelHUD,
        ShareLinkManager,
        OrbitController,
        CelestialRing,
        getKeyholeFadeTuning,
        isCelestialRingStyleSupported,
        setKeyholeFadeTuning,
        destroyWorldOverlay,
        initWorldOverlay,
        holdContinuousRender,
        releaseContinuousRender,
        governorRequestRender,
        setScopeMaskEnabled,
        isScopeMaskEnabled,
        setScopeMaskFeather,
        getScopeMaskFeather,
        setScopeTerminusOverride,
        getScopeTerminusOverride,
        clampScopeTerminusPct,
        LocationSearch,
        ...options.services,
      },
    });
  }
}
