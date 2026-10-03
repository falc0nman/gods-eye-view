import { createFrameRateMonitor } from './frameRateMonitor.js';
import { bindApplicationShortcuts } from './visualInput.js';
import { bindDisplayControls } from './displayControls.js';

/** Own keyboard/display event subscriptions; settings remain with their state owners. */
export class DisplayBindings {
  constructor({ viewer, services, elements, operations, readState }) {
    Object.assign(this, { viewer, services, readState }, elements, operations);
  }
  get shareLinkManager() {
    return this.readState().shareLinkManager;
  }
  get hud() {
    return this.readState().hud;
  }
  get bloomEnabled() {
    return this.readState().bloomEnabled;
  }
  get sharpenEnabled() {
    return this.readState().sharpenEnabled;
  }
  get celestialRing() {
    return this.readState().celestialRing;
  }
  get celestialRingEnabled() {
    return this.readState().celestialRingEnabled;
  }
  _initUI() {
    const { setScopeMaskEnabled, isScopeMaskEnabled, setScopeMaskFeather } =
      this.services;
    this._applicationShortcuts?.destroy();
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = createFrameRateMonitor({
      viewer: this.viewer,
      documentRef: document,
    });
    this._applicationShortcuts = bindApplicationShortcuts({
      documentRef: document,
      searchInput: this._locationSearch,
      actions: {
        setStyle: (style) => this.setStyle(style),
        dismissSearch: () => {
          if (this._locationSearch.classList.contains('expanded')) {
            this._locationSearch.classList.remove('expanded');
            this._locationSearch.value = '';
            this._locationSearch.blur();
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        toggleOrbit: () => this._toggleOrbit(),
        toggleCleanView: () => this.toggleCleanView(),
        toggleLayers: () =>
          document.getElementById('data-panel').classList.toggle('active'),
        toggleCctv: () => this._toggleCctvEnabled(),
      },
    });

    this._displayControls?.destroy();
    this._displayControls = bindDisplayControls({
      elements: {
        styleButtons: document.querySelectorAll('.style-btn'),
        bloomButton: this._bloomBtn,
        bloomSlider: this._bloomSlider,
        sharpenButton: this._sharpenBtn,
        sharpenSlider: this._sharpenSlider,
        scopeButton: this._scopeBtn,
        scopeFeatherSlider: this._scopeFeatherSlider,
        hudLayout: this._hudLayoutSelect,
        hudButton: this._hudBtn,
        sonarButton: this._cyberSonarBtn,
        sonarRingsSlider: this._cyberSonarRings,
        sonarRangeSlider: this._cyberSonarRange,
        sonarIntensitySlider: this._cyberSonarIntensity,
        sonarOpacitySlider: this._cyberSonarOpacity,
        sonarSectorSlider: this._cyberSonarSector,
        cleanViewButton: this._cleanViewBtn,
        cleanViewExitButton: this._cleanViewExitBtn,
        fadeSliders: [this._keyholeFadeSlider, this._keyholeOpacitySlider],
        celestialButton: this._celestialBtn,
      },
      actions: {
        setStyle: (style) => this.setStyle(style),
        toggleBloom: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomEnabled(!this.bloomEnabled);
        },
        setBloomIntensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomIntensity(value);
        },
        toggleSharpen: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setSharpenEnabled(!this.sharpenEnabled);
        },
        toggleScope: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const next = !isScopeMaskEnabled();
          setScopeMaskEnabled(next);
          this._scopeBtn.classList.toggle('active', next);
          this._scopeBtn.setAttribute('aria-pressed', String(next));
          // Labels near the edge change fade with the scope; repaint them now.
          this.viewer?.scene?.requestRender?.();
          this._syncShareState();
        },
        setScopeFeather: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const pct = Math.max(0, Math.min(100, value || 0));
          if (this._scopeFeatherValue)
            this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
          this._syncShareState();
        },
        setSharpenIntensity: (pct) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          if (this._sharpenSliderValue)
            this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
          this._syncShareState();
        },
        setHudLayout: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setHudVariant(value, { applyVisualDefaults: true });
        },
        toggleCleanView: () => this.toggleCleanView(),
        exitCleanView: () => this.toggleCleanView(false),
        setFade: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._applyKeyholeFadeFromUi();
          this._syncShareState();
        },
        toggleCelestial: () => {
          const ringIsVisible = !!this.celestialRing?.visible;
          if (!this.celestialRingEnabled || !ringIsVisible) {
            this.setCelestialRingEnabled(true, { focus: true });
          } else {
            this.setCelestialRingEnabled(false);
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        toggleSonar: () => this._setCyberSonarEnabled(),
        setSonarRings: (value) => this._setCyberSonarSetting('rings', value),
        setSonarRange: (value) => this._setCyberSonarSetting('range', value),
        setSonarIntensity: (value) =>
          this._setCyberSonarSetting('intensity', value),
        setSonarOpacity: (value) =>
          this._setCyberSonarSetting('opacity', value),
        setSonarSector: (value) => this._setCyberSonarSetting('sector', value),
      },
    });
  }
  destroy() {
    this._applicationShortcuts?.destroy();
    this._applicationShortcuts = null;
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = null;
    this._displayControls?.destroy();
    this._displayControls = null;
  }
}
