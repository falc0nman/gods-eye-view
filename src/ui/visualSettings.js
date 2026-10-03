import { STYLE_STATUS_LABELS } from './visualPresets.js';
import { UiLifetime } from './uiLifetime.js';
import {
  VisualEffects,
  STYLES,
  GLOBAL_POST_DEFAULTS,
  STYLE_PRESET_DEFAULTS,
} from './effects.js';
import { createStyleParameters } from './visualInput.js';
import * as Cesium from 'cesium';
import {
  BLOOM_SCALE_VERSION,
  clampBloomIntensity,
  decodeBloomIntensity,
} from '../bloom.js';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  normalizeCockpitVisionMode,
} from '../cockpitVisionPolicy.js';
import {
  applyCyberSonarSettings,
  isCyberSonarEnabled,
  readCyberSonarSettings,
  setCyberSonarEnabled,
} from '../cyberSonar.js';
import { cyberVisualDefaultsForHudTransition } from '../hudLayouts.js';

/** Own visual preferences and display-control state. */
export class VisualSettings {
  async restoreShareState(state) {
    const {
      setScopeMaskEnabled,
      setScopeMaskFeather,
      setScopeTerminusOverride,
      clampScopeTerminusPct,
    } = this.services;
    const {
      style,
      bloom,
      sharpen,
      bloomIntensity,
      bloomVersion,
      sharpenIntensity,
      hudVariant,
      hudVisible,
      keyholeFadePct,
      keyholeOutsideOpacityPct,
      celestialRing,
      scopeEnabled,
      scopeFeatherPct,
      scopeTerminusPct,
      mapStack,
      panelState,
      styleParams,
    } = state || {};
    // Ignore the retired 'ai-edit' style from older share links.
    if (style && style !== 'normal' && style !== 'ai-edit') {
      this.setStyle(style, {
        applyPreset: true,
        revealParameters: false,
        restore: true,
      });
    }
    if (styleParams && style && this.stages[style] && STYLES[style]?.uniforms) {
      for (const [uniformName, uniformValue] of Object.entries(styleParams)) {
        if (!Object.hasOwn(STYLES[style].uniforms, uniformName)) continue;
        this.stages[style].uniforms[uniformName] = uniformValue;
      }
      this._updateSliderPanel(style, { reveal: false });
    }
    if (typeof bloomIntensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(bloomIntensity, bloomVersion);
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof sharpenIntensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(sharpenIntensity)));
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof bloom === 'boolean') this._setBloomEnabled(bloom);
    if (typeof sharpen === 'boolean') this._setSharpenEnabled(sharpen);
    if (hudVariant) this._setHudVariant(hudVariant);
    if (typeof hudVisible === 'boolean') {
      this.hud.setMode(hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }
    if (typeof keyholeFadePct === 'number' && this._keyholeFadeSlider) {
      this._keyholeFadeSlider.value = String(keyholeFadePct);
    }
    if (
      typeof keyholeOutsideOpacityPct === 'number' &&
      this._keyholeOpacitySlider
    ) {
      this._keyholeOpacitySlider.value = String(keyholeOutsideOpacityPct);
    }
    this._applyKeyholeFadeFromUi();
    if (typeof celestialRing === 'boolean') {
      this.setCelestialRingEnabled(celestialRing, {
        syncShare: false,
        focus: false,
      });
    }
    if (typeof scopeEnabled === 'boolean') {
      setScopeMaskEnabled(scopeEnabled);
      this._scopeBtn?.classList.toggle('active', scopeEnabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeEnabled));
    }
    if (typeof scopeFeatherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeFeatherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue)
        this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }
    // null restores the altitude-adaptive ramp; a number pins the terminus
    // (clamped to the supported 94..100 band, same as the `sce` hash key).
    if (scopeTerminusPct === null) setScopeTerminusOverride(null);
    else if (typeof scopeTerminusPct === 'number') {
      const pinned = clampScopeTerminusPct(scopeTerminusPct);
      setScopeTerminusOverride(pinned == null ? null : pinned / 100);
    }
    const mapStackRestore = mapStack
      ? this._setMapStack(mapStack, { syncShare: false })
      : Promise.resolve();
    if (panelState) this._restorePanelState(panelState);
    await mapStackRestore;
    this._syncShareState();
  }

  constructor({
    viewer,
    services,
    elements,
    operations,
    mapStackController,
    readHud,
    readCockpit,
    readDataManager,
    readShareLinks,
    readCelestialRing,
    readDisplayPortalActive,
  }) {
    Object.assign(this, elements, operations, {
      viewer,
      services,
      mapStackController,
      readHud,
      readCockpit,
      readDataManager,
      readShareLinks,
      readCelestialRing,
      readDisplayPortalActive,
    });
    this._lifetime = new UiLifetime();
    this._visualEffects = new VisualEffects({
      viewer,
      requestRender: services.governorRequestRender,
      holdRender: services.holdContinuousRender,
      releaseRender: services.releaseContinuousRender,
    });
    this.activeStyle = 'normal';
    document.documentElement.dataset.gevStyle = this.activeStyle;
    this._cockpitVisionMode = 'optical';
    this._cockpitVisionRestore = null;
  }
  get hud() {
    return this.readHud();
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get _dataManager() {
    return this.readDataManager();
  }
  get shareLinkManager() {
    return this.readShareLinks();
  }
  get celestialRing() {
    return this.readCelestialRing();
  }
  get _cockpitDisplayPortalActive() {
    return this.readDisplayPortalActive();
  }
  get stages() {
    return this._visualEffects.stages;
  }

  get transitions() {
    return this._visualEffects.transitions;
  }

  get bloomEnabled() {
    return this._visualEffects.bloomEnabled;
  }

  get sharpenEnabled() {
    return this._visualEffects.sharpenEnabled;
  }

  _initStages() {
    this._visualEffects.initStyles();
  }

  _setStageIntensity(stage, value) {
    this._visualEffects.setStageIntensity(stage, value);
  }

  _syncStagesEnabledFromIntensity() {
    this._visualEffects.syncStagesEnabledFromIntensity();
  }

  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    const next = active ? normalizeCockpitVisionMode(mode) : 'optical';
    if (!this.stages) return;
    if (!active) {
      if (this._cockpitVisionRestore) {
        for (const [name, intensity] of Object.entries(
          this._cockpitVisionRestore,
        )) {
          if (this.stages[name])
            this._setStageIntensity(this.stages[name], intensity);
        }
      }
      this._cockpitVisionRestore = null;
      this._cockpitVisionMode = 'optical';
      this._syncIrBoost(); // Cockpit exit: fall back to the map preset's IR state
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    if (!this._cockpitVisionRestore) {
      this._cockpitVisionRestore = captureCockpitVisionBaseline(
        this.stages,
        this.transitions,
      );
    }
    if (next === 'optical') {
      applyCockpitVisionStageIntensities(
        this.stages,
        next,
        this._cockpitVisionRestore,
      );
      this._syncStagesEnabledFromIntensity();
      this._cockpitVisionMode = next;
      this._syncIrBoost();
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    const target = applyCockpitVisionStageIntensities(
      this.stages,
      next,
      this._cockpitVisionRestore,
    );
    this._syncStagesEnabledFromIntensity();
    this._cockpitVisionMode = next;
    this._syncIrBoost(); // Cockpit vision override ('nvg'/'thermal' boost; CRT/NOIR clear)
    this._updateSliderPanel(target || null, { reveal: false });
    this._revealCockpitStyleParameters({ openDisplay: revealParameters });
  }

  _syncIrBoost() {
    const cockpitMode = this.cockpitView?.active
      ? this._cockpitVisionMode
      : null;
    const effective =
      cockpitMode && cockpitMode !== 'optical' ? cockpitMode : this.activeStyle;
    const irBoost =
      effective === 'surveillance' ||
      effective === 'thermal' ||
      effective === 'nvg';
    // Fog blends distant geometry toward an effectively-BLACK color in this
    // app (the Cesium globe is hidden), so beyond ~100 km every 3D aircraft
    // fogs to a black silhouette — lighting and shaders can't reach past it
    // (owner cockpit-FLIR field rounds, 2026-08-16). IR sensors see through
    // haze, so the boost styles simply turn fog off; the prior state restores
    // on exit. Transition-guarded so repeated syncs don't clobber the saved value.
    const scene = this.viewer?.scene;
    if (scene?.fog && irBoost !== this._irBoostActive) {
      this._irBoostActive = irBoost;
      if (irBoost) {
        this._irFogWasEnabled = scene.fog.enabled;
        scene.fog.enabled = false;
      } else if (this._irFogWasEnabled != null) {
        scene.fog.enabled = this._irFogWasEnabled;
        this._irFogWasEnabled = null;
      }
      scene.requestRender?.();
    }
  }

  _syncCockpitInheritedStyle() {
    if (!this.cockpitView?.active || !this.stages) return;
    this._cockpitVisionRestore = Object.fromEntries(
      Object.keys(this.stages).map((name) => [
        name,
        name === this.activeStyle ? 1 : 0,
      ]),
    );
    for (const name of Object.keys(this.stages)) this.transitions.delete(name);
    this.cockpitView.setVisionMode(this.cockpitView.visionMode);
  }

  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    if (
      !this.cockpitView?.active ||
      !this._sliderPanel?.classList.contains('active')
    )
      return;
    if (
      openDisplay &&
      this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true'
    ) {
      this._setCockpitDisclosure?.('display', true);
      return;
    }
    if (this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true')
      return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    this._lifetime.frame(() =>
      this._lifetime.frame(() => {
        this._sliderPanel?.scrollIntoView?.({ block: 'nearest' });
      }),
    );
  }

  _initBloomSharpen() {
    this._visualEffects.initPostProcess(
      this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) / 100 : 0.6,
    );
  }

  _getBloomIntensity() {
    return this._visualEffects.bloomIntensity;
  }

  _syncBloomStageEnabled() {
    this._visualEffects.syncBloomEnabled();
  }

  _setBloomIntensity(intensity, { syncShare = true } = {}) {
    const { governorRequestRender } = this.services;
    governorRequestRender('bloom');
    const clamped = clampBloomIntensity(intensity);
    if (this._bloomSlider) this._bloomSlider.value = String(clamped);
    if (this._bloomSliderValue)
      this._bloomSliderValue.textContent = `${clamped}%`;
    this._applyBloomIntensity(clamped);
    if (syncShare) this._syncShareState();
  }

  _applyBloomIntensity(intensity) {
    this._visualEffects.applyBloomIntensity(intensity);
  }

  _setBloomEnabled(enabled) {
    const { governorRequestRender } = this.services;
    governorRequestRender('bloom');
    this._visualEffects.setBloomEnabled(enabled);
    this._syncBloomStageEnabled();
    this._bloomBtn.classList.toggle('active', this.bloomEnabled);
    this._bloomSliderRow.classList.toggle('visible', this.bloomEnabled);
    if (this.bloomEnabled) {
      this._applyBloomIntensity(this._getBloomIntensity());
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  _applySharpenIntensity(val) {
    this._visualEffects.applySharpenIntensity(val);
  }

  _setSharpenEnabled(enabled) {
    const { governorRequestRender } = this.services;
    governorRequestRender('sharpen');
    this._visualEffects.setSharpenEnabled(enabled);
    this._sharpenBtn.classList.toggle('active', this.sharpenEnabled);
    if (this._sharpenSliderRow) {
      this._sharpenSliderRow.classList.toggle('visible', this.sharpenEnabled);
    }
    if (this.sharpenEnabled && this._sharpenSlider) {
      this._applySharpenIntensity(
        parseInt(this._sharpenSlider.value, 10) / 100,
      );
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  _applyKeyholeFadeFromUi() {
    const { setKeyholeFadeTuning } = this.services;
    const fadePct = Math.max(
      0,
      Math.min(40, Math.round(Number(this._keyholeFadeSlider?.value) || 0)),
    );
    const outsideOpacityValue = this._keyholeOpacitySlider?.value;
    const outsideOpacityPct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          outsideOpacityValue == null ? 3 : Number(outsideOpacityValue) || 0,
        ),
      ),
    );
    if (this._keyholeFadeSlider)
      this._keyholeFadeSlider.value = String(fadePct);
    if (this._keyholeFadeValue)
      this._keyholeFadeValue.textContent = `${fadePct}%`;
    if (this._keyholeOpacitySlider)
      this._keyholeOpacitySlider.value = String(outsideOpacityPct);
    if (this._keyholeOpacityValue)
      this._keyholeOpacityValue.textContent = `${outsideOpacityPct}%`;
    setKeyholeFadeTuning({
      fadeRatio: fadePct / 100,
      outsideOpacity: outsideOpacityPct / 100,
    });
    this.viewer.scene.requestRender?.();
  }

  _setHudVariant(variantName, { applyVisualDefaults = false } = {}) {
    if (!variantName) return;
    const previousVariant = this.hud.getVariant();
    this.hud.setVariant(variantName);
    const nextVariant = this.hud.getVariant();
    if (this._hudLayoutSelect && this._hudLayoutSelect.value !== nextVariant) {
      this._hudLayoutSelect.value = nextVariant;
    }
    const visualDefaults = cyberVisualDefaultsForHudTransition(
      previousVariant,
      nextVariant,
      { explicit: applyVisualDefaults },
    );
    if (visualDefaults) this._applyCyberVisualDefaults(visualDefaults);
    this._syncCyberSonarControl();
    this._syncShareState();
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  _applyCyberVisualDefaults({ style, ironbow }) {
    this.setStyle(style, {
      applyPreset: false,
      revealParameters: false,
    });
    const thermalUniforms = this.stages?.thermal?.uniforms;
    if (!thermalUniforms || thermalUniforms.palette === undefined) return;
    thermalUniforms.palette = ironbow;
    this._updateSliderPanel('thermal', { reveal: false });
    this.services.governorRequestRender('cyber-visual-defaults');
  }

  _syncCyberSonarControl() {
    if (!this._cyberSonarBtn) return;
    const enabled = isCyberSonarEnabled();
    const settings = applyCyberSonarSettings(readCyberSonarSettings());
    this._cyberSonarBtn.classList.toggle('active', enabled);
    this._cyberSonarBtn.setAttribute('aria-pressed', String(enabled));
    this._cyberSonarBtn.textContent = enabled ? 'ON' : 'OFF';
    for (const [input, output, value, suffix] of [
      [this._cyberSonarRings, this._cyberSonarRingsValue, settings.rings, ''],
      [this._cyberSonarRange, this._cyberSonarRangeValue, settings.range, '%'],
      [
        this._cyberSonarIntensity,
        this._cyberSonarIntensityValue,
        settings.intensity,
        '%',
      ],
      [
        this._cyberSonarOpacity,
        this._cyberSonarOpacityValue,
        settings.opacity,
        '%',
      ],
      [
        this._cyberSonarSector,
        this._cyberSonarSectorValue,
        settings.sector,
        '°',
      ],
    ]) {
      if (input) input.value = String(value);
      if (output) output.textContent = `${value}${suffix}`;
    }
  }

  _setCyberSonarEnabled(enabled = !isCyberSonarEnabled()) {
    const next = setCyberSonarEnabled(!!enabled);
    this._syncCyberSonarControl();
    this.services.governorRequestRender('cyber-sonar-toggle');
    return next;
  }

  _setCyberSonarSetting(name, value) {
    const settings = readCyberSonarSettings();
    if (!Object.hasOwn(settings, name)) return settings;
    const next = applyCyberSonarSettings({ ...settings, [name]: value });
    this._syncCyberSonarControl();
    this.services.governorRequestRender(`cyber-sonar-${name}`);
    return next;
  }

  _applyStylePresetDefaults(styleName) {
    const { governorRequestRender } = this.services;
    const preset = STYLE_PRESET_DEFAULTS[styleName];
    if (!preset) return;

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [targetStyle, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[targetStyle];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
          governorRequestRender('style-param');
        }
      }
    }

    const bloomInput = preset.bloom || {};
    if (typeof bloomInput.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(bloomInput.intensity), {
        syncShare: false,
      });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    }

    const sharpenInput = preset.sharpen || {};
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(sharpenInput.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    }

    // Cyber is an explicit shell choice, independent of the imagery filter.
    // Scene/share restoration still applies its own HUD through _setHudVariant.
    if (preset.hudVariant && this.hud.getVariant() !== 'cyber') {
      this._setHudVariant(preset.hudVariant);
    }
    if (typeof preset.hudVisible === 'boolean') {
      this.hud.setMode(preset.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }
  }

  _applyGlobalPostDefaults() {
    const defaults = GLOBAL_POST_DEFAULTS;
    if (typeof defaults.bloom?.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(defaults.bloom.intensity), {
        syncShare: false,
      });
    }
    if (typeof defaults.bloom?.enabled === 'boolean') {
      this._setBloomEnabled(defaults.bloom.enabled);
    }

    if (
      typeof defaults.sharpen?.intensity === 'number' &&
      this._sharpenSlider
    ) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(defaults.sharpen.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof defaults.sharpen?.enabled === 'boolean') {
      this._setSharpenEnabled(defaults.sharpen.enabled);
    }

    if (defaults.hudVariant) {
      this._setHudVariant(defaults.hudVariant);
    }
    if (typeof defaults.hudVisible === 'boolean') {
      this.hud.setMode(defaults.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    if (this._keyholeFadeSlider) {
      this._keyholeFadeSlider.value = String(defaults.keyholeFadePct ?? 7);
    }
    if (this._keyholeOpacitySlider) {
      this._keyholeOpacitySlider.value = String(
        defaults.keyholeOutsideOpacityPct ?? 1,
      );
    }
    this._applyKeyholeFadeFromUi();
    if (typeof defaults.celestialRing === 'boolean') {
      this.setCelestialRingEnabled(defaults.celestialRing, {
        syncShare: false,
        focus: false,
      });
    }
  }

  _readShareState() {
    const {
      isScopeMaskEnabled,
      getScopeMaskFeather,
      getScopeTerminusOverride,
    } = this.services;
    return {
      bloomEnabled: this.bloomEnabled,
      sharpenEnabled: this.sharpenEnabled,
      options: {
        bloomIntensity: this._getBloomIntensity(),
        bloomVersion: BLOOM_SCALE_VERSION,
        sharpenIntensity: parseInt(this._sharpenSlider?.value || '49', 10),
        hudVariant: this.hud.getVariant(),
        hudVisible: this.hud.visible,
        keyholeFadePct: parseInt(this._keyholeFadeSlider?.value || '7', 10),
        keyholeOutsideOpacityPct: parseInt(
          this._keyholeOpacitySlider?.value || '1',
          10,
        ),
        celestialRingEnabled: this.celestialRingEnabled,
        scopeEnabled: isScopeMaskEnabled(),
        scopeFeatherPct: Math.round(getScopeMaskFeather() * 100),
        // null when adaptive — the share layer omits `sce` entirely in that case.
        scopeTerminusPct:
          getScopeTerminusOverride() == null
            ? null
            : Math.round(getScopeTerminusOverride() * 100),
        mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      },
    };
  }

  setBloom({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.bloomEnabled,
      intensityPct: this._bloomSlider
        ? parseInt(this._bloomSlider.value, 10)
        : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid bloom enabled value: ${enabled}`,
        bloom: current(),
      };
    }
    if (
      intensityPct !== undefined &&
      (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))
    ) {
      return {
        ok: false,
        error: `Invalid bloom intensity: ${intensityPct}`,
        bloom: current(),
      };
    }
    const hasExplicitVisualChange =
      intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange)
      this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      this._setBloomIntensity(
        Math.round(Math.max(0, Math.min(200, intensityPct))),
      );
    }
    if (enabled !== undefined) this._setBloomEnabled(enabled);
    return {
      ok: true,
      bloom: current(),
    };
  }

  setSharpen({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.sharpenEnabled,
      intensityPct: this._sharpenSlider
        ? parseInt(this._sharpenSlider.value, 10)
        : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid sharpen enabled value: ${enabled}`,
        sharpen: current(),
      };
    }
    if (
      intensityPct !== undefined &&
      (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))
    ) {
      return {
        ok: false,
        error: `Invalid sharpen intensity: ${intensityPct}`,
        sharpen: current(),
      };
    }
    const hasExplicitVisualChange =
      intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange)
      this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      const pct = Math.round(Math.max(0, Math.min(100, intensityPct)));
      if (this._sharpenSlider) this._sharpenSlider.value = String(pct);
      if (this._sharpenSliderValue)
        this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
      this._syncShareState();
    }
    if (enabled !== undefined) this._setSharpenEnabled(enabled);
    return {
      ok: true,
      sharpen: current(),
    };
  }

  get celestialRingEnabled() {
    return !!this.celestialRing?.enabled;
  }

  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {
    const { isCelestialRingStyleSupported } = this.services;
    const styleSupported = isCelestialRingStyleSupported(this.activeStyle);
    const current = () => ({
      enabled: this.celestialRingEnabled,
      visible: !!this.celestialRing?.visible,
    });
    if (typeof enabled !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: `Invalid celestial ring enabled value: ${enabled}`,
      };
    }
    if (typeof syncShare !== 'boolean' || typeof focus !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring options must be boolean',
      };
    }
    if (!styleSupported && enabled) {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring is available only in Normal style',
      };
    }
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('visual');
    const nextEnabled = styleSupported && enabled;
    this.celestialRing?.setEnabled(nextEnabled);
    this._celestialBtn?.classList.toggle('active', nextEnabled);
    this._celestialBtn?.setAttribute('aria-pressed', String(nextEnabled));
    if (this._celestialBtn) {
      this._celestialBtn.disabled = !styleSupported;
      this._celestialBtn.setAttribute('aria-disabled', String(!styleSupported));
      this._celestialBtn.title = styleSupported
        ? 'Celestial ring — reveal the full globe'
        : 'Celestial ring — available in Normal style';
    }
    let cameraFocused = false;
    if (nextEnabled && focus) {
      cameraFocused = !!this.celestialRing?.focusFullGlobe();
    }
    if (syncShare) this._syncShareState();
    return {
      ok: styleSupported || !enabled,
      celestialRing: current(),
      cameraFocused,
    };
  }

  getVisualState() {
    const { isScopeMaskEnabled, getScopeMaskFeather } = this.services;
    const styleParams = {};
    for (const [styleName, stage] of Object.entries(this.stages)) {
      const shader = STYLES[styleName];
      if (!shader?.uniforms) continue;
      styleParams[styleName] = {};
      for (const uniformName of Object.keys(shader.uniforms)) {
        styleParams[styleName][uniformName] = stage.uniforms[uniformName];
      }
    }

    return {
      style: this.activeStyle,
      bloom: {
        enabled: this.bloomEnabled,
        intensity: this._getBloomIntensity(),
        version: BLOOM_SCALE_VERSION,
      },
      sharpen: {
        enabled: this.sharpenEnabled,
        intensity: parseInt(this._sharpenSlider?.value || '49', 10),
      },
      hud: {
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      },
      // The keyhole fade keeps its historical `detection` key so stored
      // scenes and share links keep restoring it.
      detection: {
        fadePct: parseInt(this._keyholeFadeSlider?.value || '7', 10),
        outsideOpacityPct: parseInt(
          this._keyholeOpacitySlider?.value || '0',
          10,
        ),
      },
      scope: {
        enabled: isScopeMaskEnabled(),
        featherPct: Math.round(getScopeMaskFeather() * 100),
      },
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      styleParams,
    };
  }

  async applyVisualState(state = {}, { isCurrent = null } = {}) {
    const { setScopeMaskEnabled, setScopeMaskFeather } = this.services;
    const superseded = () => typeof isCurrent === 'function' && !isCurrent();
    if (superseded()) return false;

    if (state.style && state.style !== this.activeStyle) {
      this.setStyle(state.style, { applyPreset: false });
    }

    const bloomState = state.bloom || {};
    if (typeof bloomState.intensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(
        bloomState.intensity,
        bloomState.version ?? state.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof bloomState.enabled === 'boolean') {
      this._setBloomEnabled(bloomState.enabled);
    }

    const sharpenState = state.sharpen || {};
    if (typeof sharpenState.intensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(
        0,
        Math.min(100, Math.round(sharpenState.intensity)),
      );
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof sharpenState.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenState.enabled);
    }

    const hudState = state.hud || {};
    if (hudState.variant) {
      this._setHudVariant(hudState.variant);
    }
    if (typeof hudState.visible === 'boolean') {
      this.hud.setMode(hudState.visible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    const scopeState = state.scope || {};
    if (typeof scopeState.enabled === 'boolean') {
      setScopeMaskEnabled(scopeState.enabled);
      this._scopeBtn?.classList.toggle('active', scopeState.enabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeState.enabled));
    }
    if (typeof scopeState.featherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeState.featherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue)
        this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }

    const detectionState = state.detection || {};
    if (typeof detectionState.fadePct === 'number' && this._keyholeFadeSlider) {
      this._keyholeFadeSlider.value = String(detectionState.fadePct);
    }
    if (
      typeof detectionState.outsideOpacityPct === 'number' &&
      this._keyholeOpacitySlider
    ) {
      this._keyholeOpacitySlider.value = String(
        detectionState.outsideOpacityPct,
      );
    }
    this._applyKeyholeFadeFromUi();

    if (state.mapStack) {
      // The stack switch is itself a MUTATION, not merely a suspension point,
      // so it needs a gate on BOTH sides of the await.
      if (superseded()) return false;
      const stackBefore = this.mapStackController?.getActiveId?.() ?? null;
      const genBefore =
        this.mapStackController?.getSwitchGeneration?.() ?? null;

      await this._setMapStack(state.mapStack, { syncShare: false });

      if (superseded()) {
        // Superseded DURING the switch, which the pre-check above cannot catch
        // and which has already moved the globe. The controller only
        // invalidates a switch when another setStack() arrives, and a winning
        // state that omits `mapStack` never issues one — every normalized scene
        // shot omits it — so this stale globe would simply stand. Put back what
        // the winner inherited.
        const genAfter =
          this.mapStackController?.getSwitchGeneration?.() ?? null;
        // _setMapStack issues exactly one setStack(), which advances the
        // generation once, or not at all when the stack was unavailable and
        // nothing was mutated. Anything past that is a NEWER switch whose
        // caller owns the globe now, and reverting would stomp a live intent.
        const globeIsStillOurs =
          genBefore !== null && genAfter !== null && genAfter <= genBefore + 1;
        const landed = this.mapStackController?.getActiveId?.() ?? null;
        if (globeIsStillOurs && stackBefore && landed !== stackBefore) {
          await this._setMapStack(stackBefore, { syncShare: false });
        }
        return false;
      }
      // Everything below is the uniform commit, already past its own gate.
    }

    if (state.styleParams && typeof state.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(state.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params) continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
    return true;
  }

  applyCinematicPreset(preset = {}) {
    const bloomInput =
      typeof preset.bloom === 'object'
        ? preset.bloom
        : { intensity: preset.bloom };
    let decodedBloomIntensity = null;
    if (typeof bloomInput.intensity === 'number') {
      decodedBloomIntensity = decodeBloomIntensity(
        bloomInput.intensity,
        bloomInput.version ?? preset.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(decodedBloomIntensity, { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    } else if (typeof bloomInput.intensity === 'number') {
      this._setBloomEnabled(
        (decodedBloomIntensity ?? this._getBloomIntensity()) > 0,
      );
    }

    const sharpenInput =
      typeof preset.sharpen === 'object'
        ? preset.sharpen
        : { enabled: preset.sharpen };
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(sharpenInput.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    } else if (typeof sharpenInput.intensity === 'number') {
      this._setSharpenEnabled(sharpenInput.intensity > 0);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }

      // Keep slider panel values in sync when updating the active style.
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
  }

  _updateSliderPanel(styleName, { reveal = false } = {}) {
    const { governorRequestRender } = this.services;
    this._styleParameters ||= createStyleParameters({
      container: this._sliderContainer,
    });
    this._styleParameters.clear();
    const shader = STYLES[styleName];

    if (!shader || !shader.uniforms || styleName === 'normal') {
      this._sliderPanel.classList.remove('active');
      this._scheduleRightPanelLayout();
      return;
    }

    this._styleParameters.render({
      uniforms: shader.uniforms,
      readValue: (uName) => this.stages[styleName].uniforms[uName],
      writeValue: (uName, val) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.stages[styleName].uniforms[uName] = val;
      },
      onChange: () => {
        // Uniform writes need an explicit render under the idle governor.
        governorRequestRender('style-param-slider');
        this._syncShareState();
      },
    });

    this._sliderPanel.classList.add('active');
    this._scheduleRightPanelLayout();
    if (reveal) this._revealStyleParameters();
  }

  _revealStyleParameters() {
    if (!this._sliderPanel?.classList.contains('active')) return;
    if (this._cockpitDisplayPortalActive) return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    this.setPanelCollapsed('pp-toggles', false, { explicit: true });
    this._lifetime.frame(() =>
      this._lifetime.frame(() => {
        const scrollOwner = this._ppToggles;
        if (!scrollOwner) return;
        const ownerRect = scrollOwner.getBoundingClientRect();
        const panelRect = this._sliderPanel.getBoundingClientRect();
        scrollOwner.scrollTop += panelRect.top - ownerRect.top - 8;
      }),
    );
  }

  setStyle(
    styleName,
    {
      applyPreset = true,
      revealParameters = applyPreset,
      restore = false,
    } = {},
  ) {
    if (!restore) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (styleName === this.activeStyle) {
      if (revealParameters && styleName !== 'normal')
        this._revealStyleParameters();
      return;
    }

    const previousStyle = this.activeStyle;
    this.activeStyle = styleName;
    document.documentElement.dataset.gevStyle = styleName;

    // The celestial optics treatment belongs to the unfiltered globe only.
    // Leaving Normal turns it off; returning merely re-enables the control.
    this.setCelestialRingEnabled(false, { syncShare: false, focus: false });

    // Transition out the previous shader style
    if (previousStyle !== 'normal' && this.stages[previousStyle]) {
      this._startTransition(
        previousStyle,
        this.stages[previousStyle].uniforms.intensity,
        0.0,
      );
    }

    // Transition in the new shader style
    if (styleName !== 'normal' && this.stages[styleName]) {
      this._startTransition(
        styleName,
        this.stages[styleName].uniforms.intensity,
        1.0,
      );
    }

    if (applyPreset) {
      this._applyStylePresetDefaults(styleName);
    }

    // Update button UI
    document.querySelectorAll('.style-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === styleName);
    });

    // Update style indicator
    const displayNames = { surveillance: 'NVG', thermal: 'FLIR', retro: 'CRT' };
    this._styleIndicator.textContent =
      displayNames[styleName] || styleName.toUpperCase();
    this._updateStyleMiniStatus(styleName);

    // Update parameter sliders
    this._updateSliderPanel(styleName, { reveal: revealParameters });

    // Notify HUD (color adaptation + auto show/hide)
    this.hud.onStyleChange(styleName);
    this._updateHudButtonState();

    this._syncIrBoost();
    window.dispatchEvent(
      new CustomEvent('gev:style-change', {
        detail: { style: styleName },
      }),
    );

    this._syncCockpitInheritedStyle();

    // Notify share link manager
    this.shareLinkManager.onStyleChange(styleName);
    this._syncShareState();
  }

  _startTransition(styleName, fromValue, toValue) {
    this._visualEffects.startTransition(styleName, fromValue, toValue);
  }

  _updateStyleMiniStatus(styleName = this.activeStyle) {
    if (!this._styleMiniValue) return;
    this._styleMiniValue.textContent =
      STYLE_STATUS_LABELS[styleName] ||
      String(styleName || 'normal').toUpperCase();
  }

  _updateHudButtonState() {
    this._hudBtn.classList.toggle('active', this.hud.visible);
    if (this._hudLayoutRow) {
      this._hudLayoutRow.classList.toggle('visible', this.hud.visible);
    }
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  stop() {
    this._lifetime.destroy();
    this._styleParameters?.destroy();
    this._visualEffects.stop();
  }
  releaseIrBoost() {
    if (!this._irBoostActive) return;
    if (this._irFogWasEnabled != null && this.viewer?.scene?.fog)
      this.viewer.scene.fog.enabled = this._irFogWasEnabled;
    this._irBoostActive = false;
    this._irFogWasEnabled = null;
  }
  destroy() {
    this.stop();
    this.releaseIrBoost();
    this._visualEffects.destroy();
  }
}
