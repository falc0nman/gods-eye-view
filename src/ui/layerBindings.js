import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from '../cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from '../worldFocus.js';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';
/** Own manager subscriptions and the camera-entry events that outlive controls. */
export class LayerBindings {
  constructor({
    viewer,
    services,
    readControls,
    operations,
    feedback,
    shareRestoration,
  }) {
    Object.assign(
      this,
      {
        viewer,
        services,
        readControls,
        _feedback: feedback,
        _shareRestoration: shareRestoration,
      },
      operations,
    );
    this._disposed = false;
    this._dataManager = null;
    this._directionsShellModule = null;
    this._weatherShellModules = [];
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
  }
  get hud() {
    return this.readControls().hud;
  }
  get _contextControls() {
    return this.readControls()._contextControls;
  }
  get _cctvControls() {
    return this.readControls()._cctvControls;
  }
  get _radioControls() {
    return this.readControls()._radioControls;
  }
  observeCamera() {
    this._cctvRequestFocusHandler = (event) =>
      routeCctvFocusRequest(
        event,
        (activate, focus) => this._runExplicitCctvFocus(activate, focus),
        (cameraId, durationSec) =>
          this.services.cctvLayer.focusCamera(cameraId, durationSec),
      );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) =>
      routeWorldFocusRequest(
        event,
        (detail, fly) => this._runExplicitWorldFocus(detail, fly),
        (detail) => flyToWorldTarget(this.viewer, detail),
      );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover =
      this.viewer.trackedEntityChanged.addEventListener((entity) => {
        if (entity && !this._disposed)
          this._stampNavigation({ cancelPendingSelection: false });
      });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener =
      registerNavigationAuthorityListener(window, (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection:
            event?.detail?.cancelPendingSelection !== false,
        });
      });
  }
  _connectDirectionsCamera() {
    if (!this._dataManager) {
      // Detaching: the layer outlives this shell, so it must not keep calling
      // a facade whose viewer is going away.
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
      return;
    }
    const directions = this._dataManager.layers?.get('directions')?.module;
    if (this._directionsShellModule !== directions) {
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
    }
    if (typeof directions?.attachShellServices !== 'function') return;
    this._directionsShellModule = directions;
    directions.attachShellServices({
      runNavigation: (navigate) =>
        this.runImmediateNavigation('route', navigate),
      floorFn: (lat, lon) => this.services.cachedGroundFloor(lat, lon),
      warmFn: (cells) => this.services.warmGroundFloor(cells),
      showToast: (message) => this._showToast(message),
    });
  }

  _connectWeatherCamera() {
    for (const layer of this._weatherShellModules)
      layer.attachShellServices?.(null);
    this._weatherShellModules = [];
    for (const id of [
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ]) {
      const layer = this._dataManager?.layers?.get(id)?.module;
      if (typeof layer?.attachShellServices !== 'function') continue;
      layer.attachShellServices({
        runNavigation: (navigate) =>
          this.runImmediateNavigation('weather', navigate),
        imageryHost: this.services.imageryHost,
      });
      this._weatherShellModules.push(layer);
    }
  }

  attachDataManager(dataManager) {
    if (this._disposed) return;
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._contextControls.connect(this._dataManager);
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._feedback._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._cctvControls.connect();
    this._radioControls.connect();
    this._connectDirectionsCamera();
    this._connectWeatherCamera();
    this._shareRestoration.connect(this._dataManager);
  }
  stop() {
    if (this._disposed) return;
    this._disposed = true;

    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
  }
  disconnect() {
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    this._directionsShellModule?.attachShellServices?.(null);
    this._directionsShellModule = null;
    this._dataManager = null;
    this._connectWeatherCamera();
  }
}
