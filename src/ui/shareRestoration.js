import { LayerStateCoordinator } from '../data/layerState.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';

/** Own initial share restoration and durable layer state. */
export class ShareRestoration {
  constructor({ viewer, navigation, syncShareState }) {
    Object.assign(this, { viewer, navigation, syncShareState });
    this._disposed = false;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
  }
  attachLinks(shareLinkManager) {
    this.shareLinkManager = shareLinkManager;
    this._initialShareState = shareLinkManager.parseInitialHash();
  }
  start() {
    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => {
          this._resolveInitialShareRestore = resolve;
        })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer user or voice navigation has won.
      this._initialShareNavigationGeneration =
        this.navigation._beginDeferredNavigation('shared view');
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera =
          Number.isInteger(generation) &&
          this.navigation._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise ||
              Promise.resolve([]));
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'settled',
              share,
              layers,
            });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this.syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed ||
        !this._hasShareState ||
        !this._resolveInitialShareRestore
      )
        return;
      stampInitialShareGesture(() => this.navigation._stampNavigation());
    };
    this.viewer?.canvas?.addEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
    this.viewer?.canvas?.addEventListener(
      'wheel',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
  }
  connect(dataManager) {
    this._dataManager = dataManager;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      this._layerStateCoordinator = new LayerStateCoordinator(
        this._dataManager,
        this.shareLinkManager,
      );
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
    }
  }
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
  }
  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(
      new CustomEvent('gev:initial-share-restore-settled', { detail: result }),
    );
  }
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({
      status: 'destroyed',
      share: null,
      layers: [],
    });
    this.viewer?.canvas?.removeEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
    );
    this.viewer?.canvas?.removeEventListener(
      'wheel',
      this._initialShareGestureHandler,
    );
    this._initialShareGestureHandler = null;
  }
}
