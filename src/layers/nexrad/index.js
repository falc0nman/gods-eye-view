import * as Cesium from 'cesium';
import { createRadarLegend, radarLegendModel } from './legend.js';
import { createRadarReadout } from './readout.js';
import { nearestRadarSite, radarIcao } from './source.js';

/**
 * NEXRAD single-radar products for the radar nearest the centre of the view,
 * picked with the row's chips:
 *
 *   REF  super-res reflectivity        N0B…N3B   (4 tilts)
 *   VEL  super-res base velocity       N0G, N1G  (2 tilts)
 *   SRV  storm-relative velocity       N0S
 *   CC   correlation coefficient       N0C…N3C   (4 tilts)
 *   ZDR  differential reflectivity     N0X…N3X   (4 tilts)
 *   KDP  specific differential phase   N0K…N3K   (4 tilts)
 *   HC   hydrometeor classification    N0H…N3H   (4 tilts)
 *   VIL  digital vertically integrated liquid (DVL)
 *   ET   enhanced echo tops (EET)
 *
 * Each is a NOAA Level III file decoded and rendered by this app's server
 * (server/providers/nexrad.js); the browser receives one finished image per
 * scan. The national mosaic is the separate Weather Radar layer (MRMS).
 *
 * The imagery rides ONLY `viewer.imageryLayers` — the Cesium globe. It must
 * NOT be draped onto the Google Photorealistic tileset: Cesium drapes by
 * computing cartographic positions and texture coordinates on the CPU for
 * every vertex of every loaded tile, and over a dense 3D city that froze the
 * whole machine. In the photoreal stack the row says the radar needs a globe
 * map instead of pretending it is on screen.
 *
 * A newer scan of the same product crossfades; switching product or radar
 * replaces at once, so two products never overlap.
 */

export const NEXRAD_STALE_AFTER_MS = 20 * 60_000;
export const NEXRAD_LAYER_ALPHA = 0.7;
const RETIRE_PREVIOUS_SCAN_MS = 8_000;

const tilts = (letter, count) =>
  Object.freeze(Array.from({ length: count }, (_, i) => `N${i}${letter}`));

/** `codes` are the Level III products per tilt, lowest first. */
export const NEXRAD_PRODUCTS = Object.freeze({
  ref: Object.freeze({
    codes: tilts('B', 4),
    chip: 'REF',
    title: 'Super-res reflectivity (dBZ)',
  }),
  vel: Object.freeze({
    codes: tilts('G', 2),
    chip: 'VEL',
    title: 'Super-res base velocity (green toward, red away)',
  }),
  srv: Object.freeze({
    codes: Object.freeze(['N0S']),
    chip: 'SRV',
    title: 'Storm-relative velocity (kt)',
  }),
  cc: Object.freeze({
    codes: tilts('C', 4),
    chip: 'CC',
    title: 'Correlation coefficient (low CC in a hook = debris)',
  }),
  zdr: Object.freeze({
    codes: tilts('X', 4),
    chip: 'ZDR',
    title: 'Differential reflectivity (dB)',
  }),
  kdp: Object.freeze({
    codes: tilts('K', 4),
    chip: 'KDP',
    title: 'Specific differential phase (°/km)',
  }),
  hc: Object.freeze({
    codes: tilts('H', 4),
    chip: 'HC',
    title: 'Hydrometeor classification',
  }),
  vil: Object.freeze({
    codes: Object.freeze(['DVL']),
    chip: 'VIL',
    title: 'Vertically integrated liquid (kg/m²)',
  }),
  et: Object.freeze({
    codes: Object.freeze(['EET']),
    chip: 'ET',
    title: 'Enhanced echo tops (kft)',
  }),
});

/** `HH:MMZ` label for the toggle row. */
export function formatScanLabel(validMs) {
  if (!Number.isFinite(validMs)) return null;
  return `scan ${new Date(validMs).toISOString().slice(11, 16)}Z`;
}

/** Globe imagery only — never a 3D tileset (see the module header). */
function imageryTargets(viewer) {
  return viewer?.imageryLayers ? [viewer.imageryLayers] : [];
}

async function defaultMakeProvider(spec) {
  const { west, south, east, north } = spec.bounds;
  return Cesium.SingleTileImageryProvider.fromUrl(spec.image, {
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
  });
}

/** Lat/lon at the centre of the view (the camera's sub-point if the centre is sky). */
function viewCenter(viewer) {
  const canvas = viewer?.scene?.canvas;
  let carto = null;
  if (canvas && typeof viewer.camera?.pickEllipsoid === 'function') {
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    if (hit) carto = Cesium.Cartographic.fromCartesian(hit);
  }
  carto ??= viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

export function createNexradLayer({
  source,
  now = () => Date.now(),
  locate = viewCenter,
  makeProvider = defaultMakeProvider,
  legend = createRadarLegend(),
  createReadout = createRadarReadout,
} = {}) {
  if (
    typeof source?.getScan !== 'function' ||
    typeof source?.getSites !== 'function'
  )
    throw new TypeError('NEXRAD requires a radar source');
  let _viewer = null;
  let _enabled = false;
  /** @type {{key: string, series: string, attachments: Array<{collection: any, layer: any}>}|null} */
  let _current = null;
  const _retiring = new Set();
  let _product = 'ref';
  let _tilt = 0;
  let _scan = null;
  let _site = null;
  let _sites = null;
  let _noRadar = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _seq = 0;
  let _removeMoveEnd = null;
  let _rowListener = null;
  let _readout = null;

  const detach = (attachments) => {
    for (const { collection, layer } of attachments) {
      if (!collection.isDestroyed?.() && collection.contains(layer))
        collection.remove(layer, true);
    }
  };

  const retireAll = () => {
    for (const timer of _retiring) {
      clearTimeout(timer.id);
      detach(timer.attachments);
    }
    _retiring.clear();
    if (_current) detach(_current.attachments);
    _current = null;
  };

  const show = async (spec, seq) => {
    if (!_viewer || (_current && _current.key === spec.key)) return;
    let providers;
    try {
      providers = await Promise.all(
        imageryTargets(_viewer).map(() => makeProvider(spec)),
      );
    } catch {
      _lastError = 'radar image failed to load';
      return;
    }
    if (seq !== _seq || !_enabled) return;
    const attachments = imageryTargets(_viewer).map((collection, i) => {
      const layer = new Cesium.ImageryLayer(providers[i], {
        alpha: NEXRAD_LAYER_ALPHA,
      });
      collection.add(layer);
      return { collection, layer };
    });
    const previous = _current;
    _current = { key: spec.key, series: spec.series, attachments };
    if (previous && previous.series !== spec.series) {
      detach(previous.attachments);
    } else if (previous) {
      const timer = { id: null, attachments: previous.attachments };
      timer.id = setTimeout(() => {
        _retiring.delete(timer);
        detach(timer.attachments);
        _viewer?.scene?.requestRender?.();
      }, RETIRE_PREVIOUS_SCAN_MS);
      _retiring.add(timer);
    }
    _viewer?.scene?.requestRender?.();
  };

  const productCode = () => {
    const codes = NEXRAD_PRODUCTS[_product].codes;
    return codes[Math.min(_tilt, codes.length - 1)];
  };

  async function refreshSite(signal, seq) {
    if (!_sites) {
      try {
        _sites = await source.getSites({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        _lastError = 'radar site list unavailable';
        return;
      }
    }
    const center = locate(_viewer);
    const site = center
      ? nearestRadarSite(_sites, center.lat, center.lon)
      : null;
    if (seq !== _seq || !_enabled) return;
    _noRadar = !site;
    if (!site) {
      // Over the ocean / abroad: nothing to show, and say why.
      retireAll();
      _site = null;
      _scan = null;
      _lastError = null;
      return;
    }
    const code = productCode();
    const series = `${site.id}_${code}`;
    let scan;
    try {
      scan = await source.getScan(site.id, code, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (seq !== _seq) return;
      // Never leave another product's image under this product's label.
      if (_current?.series !== series) retireAll();
      _site = site;
      _lastError = error.message;
      return;
    }
    if (seq !== _seq || !_enabled) return;
    _site = site;
    _scan = scan;
    _lastError = null;
    _lastUpdate = now();
    await show(
      { series, key: scan.key, image: scan.image, bounds: scan.bounds },
      seq,
    );
  }

  /** Show the legend only while radar is actually on screen. */
  const syncLegend = () => {
    const onScreen =
      _enabled && !_noRadar && _viewer?.scene?.globe?.show !== false;
    if (!onScreen) legend.hide();
    else
      legend.show(
        radarLegendModel(_product, {
          elevationDeg: _scan?.elevationDeg ?? null,
        }),
      );
  };
  const onMapStackChanged = () => syncLegend();

  /** The scan under the cursor readout, or null when there are no values to read. */
  const readoutTarget = () => {
    if (!_enabled || !_scan || !_site) return null;
    if (_viewer?.scene?.globe?.show === false) return null;
    if (_current?.key !== _scan.key) return null; // image not on screen yet
    return { key: _scan.key, group: _product };
  };

  const refresh = async (signal) => {
    const seq = ++_seq;
    await refreshSite(signal, seq);
    syncLegend();
    _rowListener?.();
  };

  const onMoveEnd = () => {
    if (!_enabled || !_sites) return;
    const center = locate(_viewer);
    const site = center
      ? nearestRadarSite(_sites, center.lat, center.lon)
      : null;
    if ((site?.id ?? null) !== (_site?.id ?? null) || !site !== _noRadar)
      void refresh();
  };

  const layer = {
    id: 'nexrad',
    name: 'NEXRAD Single Radar',
    icon: '📡',
    source: 'NOAA NEXRAD Level III',
    updateInterval: 120_000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
    },

    enable() {
      _enabled = true;
      _removeMoveEnd ??=
        _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) ?? null;
      // Switching to/from the photoreal map hides/shows the globe the radar rides on.
      globalThis.addEventListener?.('gev:map-stack-changed', onMapStackChanged);
      if (_viewer?.scene?.canvas)
        _readout ??= createReadout({
          viewer: _viewer,
          getTarget: readoutTarget,
          getValue: (key, lat, lon, options) =>
            source.getValue(key, lat, lon, options),
        });
      syncLegend();
    },

    disable() {
      _enabled = false;
      _seq += 1;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      globalThis.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      retireAll();
      legend.hide();
      _readout?.hide();
    },

    async update(viewer, { signal } = {}) {
      if (!_enabled) return true;
      await refresh(signal);
      return true;
    },

    destroy() {
      layer.disable();
      legend.destroy();
      _readout?.destroy();
      _readout = null;
      _viewer = null;
    },

    /** @internal test seam: what the cursor readout would query right now. */
    readoutTarget() {
      return readoutTarget();
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const chips = Object.entries(NEXRAD_PRODUCTS).map(([id, p]) => ({
        id,
        label: p.chip,
        title: p.title,
        active: _product === id,
        params: { product: id },
      }));
      const codes = NEXRAD_PRODUCTS[_product].codes;
      if (codes.length > 1) {
        const tilt = Math.min(_tilt, codes.length - 1);
        const elev = Number.isFinite(_scan?.elevationDeg)
          ? ` ${_scan.elevationDeg.toFixed(1)}°`
          : '';
        chips.push({
          id: 'tilt',
          label: `TILT ${tilt + 1}/${codes.length}${elev}`,
          title: 'Next elevation angle (wraps to the lowest)',
          params: { tilt: (tilt + 1) % codes.length },
        });
      }
      return { chips };
    },

    getParams() {
      return { product: _product, tilt: _tilt };
    },

    /** `{product}` and/or `{tilt}` (0 = lowest elevation). */
    setParams(params = {}) {
      const product = params.product ?? _product;
      const tilt =
        params.tilt ??
        (params.product && params.product !== _product ? 0 : _tilt);
      if (!Object.hasOwn(NEXRAD_PRODUCTS, product)) return false;
      if (!Number.isInteger(tilt) || tilt < 0 || tilt > 3) return false;
      if (product !== _product || tilt !== _tilt) {
        _product = product;
        _tilt = tilt;
        _scan = null;
        _noRadar = false;
        _lastError = null;
        if (_enabled) void refresh();
      }
      return true;
    },

    getStats() {
      const scanAgeMs = Number.isFinite(_scan?.scanMs)
        ? now() - _scan.scanMs
        : null;
      const stale = scanAgeMs !== null && scanAgeMs > NEXRAD_STALE_AFTER_MS;
      const globeHidden = _enabled && _viewer?.scene?.globe?.show === false;
      const product = NEXRAD_PRODUCTS[_product];
      let label = '';
      if (_noRadar) {
        label = `${product.chip} · no radar near the view centre`;
      } else if (_site && _scan) {
        const elev = Number.isFinite(_scan.elevationDeg)
          ? ` ${_scan.elevationDeg.toFixed(1)}°`
          : '';
        label = `${radarIcao(_site)} ${product.chip}${elev} · ${formatScanLabel(_scan.scanMs)} · ${_site.name}`;
      } else if (_site) {
        label = `${radarIcao(_site)} ${product.chip} · ${_site.name}`;
      }
      return {
        count: _site ? 1 : 0,
        lastUpdate: _scan?.scanMs ?? _lastUpdate,
        error: _lastError,
        stale,
        loadingLabel: label,
        ...(_noRadar ? { status: 'idle' } : {}),
        // Photoreal stack: the globe (radar's only surface) is hidden. A
        // guidance state, not a feed fault.
        ...(globeHidden
          ? {
              status: 'idle',
              loadingLabel: 'switch to a globe map (Esri/OSM) to view radar',
            }
          : {}),
      };
    },
  };
  return layer;
}
