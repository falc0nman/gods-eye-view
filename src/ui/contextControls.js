/**
 * The Context panel's remaining controls: Clear All and the user-facing action
 * runner that Radio shares. The Context modes (Contacts, Space Missions) were
 * removed by GW-58; the panel itself stays because it houses Radio.
 */
export class ContextControls {
  constructor({ actions }) {
    this.actions = actions;
    this.destroyed = false;
    this._dataManager = null;
    this._preservePanelStateDuringLayerClear = false;
    this._clearSelectedLayersPromise = null;
  }
  showToast(...args) {
    if (!this.destroyed) this.actions.showToast(...args);
  }
  setClearBusy(...args) {
    if (!this.destroyed) this.actions.setClearBusy(...args);
  }
  connect(manager) {
    if (this.destroyed) return;
    this._dataManager = manager || null;
  }
  disconnect() {
    this._dataManager = null;
  }
  stop() {
    this.destroyed = true;
  }

  /**
   * Run a user-requested layer operation and toast once if it fails. A false
   * result counts as a failure unless `falseIsFailure` is off.
   */
  async _runUserFacingContextAction(
    operation,
    message = 'Context could not restore every layer; try again',
    { falseIsFailure = true } = {},
  ) {
    if (this.destroyed) return false;
    const notificationToken = Symbol('user-facing-context-action');
    try {
      const result = await operation(notificationToken);
      if (result === false && falseIsFailure) throw new Error(message);
      return result;
    } catch (error) {
      if (!this.destroyed) {
        console.warn('[Context] user-facing action failed', error);
        try {
          this.showToast(message);
        } catch {
          // A broken error surface must not recreate the unhandled rejection.
        }
      }
      return false;
    }
  }

  clearSelectedLayers() {
    const empty = {
      targetIds: [],
      items: [],
      clearedIds: [],
      notClearedIds: [],
    };
    if (this.destroyed) return Promise.resolve({ ...empty, cancelled: true });
    if (this._clearSelectedLayersPromise)
      return this._clearSelectedLayersPromise;
    if (!this._dataManager?.clearSelectedLayers) return Promise.resolve(empty);
    const notificationToken = Symbol('clear-selected-layers');
    this._preservePanelStateDuringLayerClear = true;
    this.setClearBusy(true);
    const operation = this._dataManager
      .clearSelectedLayers({ origin: 'user', notificationToken })
      .then((result) => {
        if (result.targetIds.length === 0) {
          this.showToast('No selected data layers');
        } else if (result.notClearedIds.length > 0) {
          this.showToast(
            `${result.notClearedIds.length} data layer${result.notClearedIds.length === 1 ? '' : 's'} could not be cleared`,
          );
        } else {
          this.showToast(
            `Cleared ${result.clearedIds.length} data layer${result.clearedIds.length === 1 ? '' : 's'}`,
          );
        }
        return result;
      })
      .catch((error) => {
        console.warn('[Data] clear selected layers failed', error);
        this.showToast('Selected data layers could not be cleared');
        return { ...empty, error };
      })
      .finally(() => {
        this.setClearBusy(false);
        this._preservePanelStateDuringLayerClear = false;
        this._clearSelectedLayersPromise = null;
      });
    this._clearSelectedLayersPromise = operation;
    return operation;
  }
}
