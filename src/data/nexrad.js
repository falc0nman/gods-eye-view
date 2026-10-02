import * as Cesium from 'cesium';

/**
 * NEXRAD weather radar from the Iowa Environmental Mesonet (IEM). Keyless and
 * CORS-open. Three products, picked with the row's chips:
 *
 *   COMPOSITE    national base-reflectivity mosaic (N0Q), CONUS, ~1 km
 *   REFLECTIVITY one radar's super-resolution reflectivity (Level III N0B)
 *   SRV          one radar's storm-relative velocity (Level III N0S)
 *
 * The single-radar products follow the radar nearest the centre of the view,
 * re-chosen when the camera stops moving. They use N0B, not N0Q/N0U: NWS
 * retired the per-site N0Q/N0U in 2022 and IEM's copies froze then (verified
 * 2026-10-01: their last scan is 2022-09-08). IEM serves no other current
 * per-site products (base velocity N0G, dual-pol, higher tilts) — those need
 * decoding NOAA's raw Level II/III files, which this layer does not do.
 *
 * Every refresh pins the imagery to ONE named scan instead of the rolling
 * "latest" alias, so the tiles on screen match the scan time the row reports.
 * Only when the metadata probe fails does the layer fall back to the rolling
 * alias, and it says so (`fallback`) rather than claiming a scan time.
 *
 * The imagery rides ONLY `viewer.imageryLayers` — the Cesium globe used by the
 * Esri/Bing/OSM stacks. It must NOT be draped onto the Google Photorealistic
 * tileset (`Cesium3DTileset.imageryLayers`): Cesium drapes by computing
 * cartographic positions and texture coordinates on the CPU for every vertex of
 * every loaded photoreal tile, and over a dense 3D city that froze the whole
 * machine. In the photoreal stack the globe is hidden, so the row says the
 * radar needs a globe map instead of pretending it is on screen.
 *
 * A refresh ADDS the new scan on top and retires the previous one a few
 * seconds later, so the radar never blinks out while new tiles stream in.
 */

const IEM_TILE_ROOT = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0';
const LATEST_ALIAS = 'nexrad-n0q-900913';
const META_URL = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
const SITES_URL = 'https://mesonet.agron.iastate.edu/geojson/network/NEXRAD.geojson';
const SITE_META_URL = (site, code) =>
  `https://mesonet.agron.iastate.edu/data/gis/images/4326/ridge/${site}/${code}_0.json`;

/** The N0Q composite's extent (CONUS). No tiles are requested outside it. */
export const NEXRAD_COVERAGE_DEG = Object.freeze({ west: -126, south: 24, east: -66, north: 50 });
/** ~1 km source resolution; deeper zooms upsample instead of re-requesting. */
export const NEXRAD_MAX_TILE_LEVEL = 8;
/** Super-res single-radar products hold detail to roughly zoom 10. */
const SITE_MAX_TILE_LEVEL = 10;
/** Single-radar products reach ~460 km from the radar. */
const SITE_RANGE_KM = 460;
/** IEM publishes every 5 min; three missed mosaics reads as stale. */
export const NEXRAD_STALE_AFTER_MS = 20 * 60_000;
export const NEXRAD_LAYER_ALPHA = 0.7;
const RETIRE_PREVIOUS_SCAN_MS = 8_000;

export const NEXRAD_PRODUCTS = Object.freeze({
  composite: Object.freeze({ chip: 'COMPOSITE', short: 'COMPOSITE', title: 'National base reflectivity mosaic' }),
  ref: Object.freeze({ code: 'N0B', chip: 'REFLECTIVITY', short: 'REF', title: 'Nearest radar · super-resolution reflectivity (N0B)' }),
  srv: Object.freeze({ code: 'N0S', chip: 'SRV', short: 'SRV', title: 'Nearest radar · storm-relative velocity (N0S)' }),
});

/**
 * Format a scan time as IEM's UTC `YYYYMMDDHHMM` product stamp.
 * @param {number} validMs Epoch milliseconds.
 * @returns {string|null}
 */
export function nexradScanStamp(validMs) {
  if (!Number.isFinite(validMs)) return null;
  const d = new Date(validMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

const isStamp = (stamp) => /^\d{12}$/.test(String(stamp ?? ''));

/**
 * Composite tile URL template for one named scan, or the rolling latest alias
 * when no stamp is known.
 * @param {string|null} stamp
 * @returns {string}
 */
export function nexradTileTemplate(stamp) {
  const product = isStamp(stamp) ? `ridge::USCOMP-N0Q-${stamp}` : LATEST_ALIAS;
  return `${IEM_TILE_ROOT}/${product}/{z}/{x}/{y}.png`;
}

/**
 * Single-radar tile URL template; no stamp → that radar's latest scan.
 * @param {string} site IEM 3-letter id, e.g. `TLX`.
 * @param {string} code Level III product, e.g. `N0B`.
 * @param {string|null} stamp
 */
export function siteTileTemplate(site, code, stamp) {
  if (!/^[A-Z0-9]{3}$/.test(site) || !/^[A-Z0-9]{3}$/.test(code)) throw new Error('bad radar site or product');
  return `${IEM_TILE_ROOT}/ridge::${site}-${code}-${isStamp(stamp) ? stamp : '0'}/{z}/{x}/{y}.png`;
}

/**
 * Parse IEM's composite metadata (`{"meta": {"valid": ISO, "radar_quorum": "143/147"}}`).
 * Single-radar metadata has the same shape without the quorum.
 * @param {unknown} json
 * @returns {{validMs: number, stamp: string, radarsReporting: number|null, radarsTotal: number|null}|null}
 */
export function parseNexradMeta(json) {
  const meta = json && typeof json === 'object' ? json.meta : null;
  if (!meta || typeof meta.valid !== 'string') return null;
  const validMs = Date.parse(meta.valid);
  const stamp = nexradScanStamp(validMs);
  if (!stamp) return null;
  const quorum = /^(\d+)\/(\d+)$/.exec(String(meta.radar_quorum ?? '').trim());
  return {
    validMs,
    stamp,
    radarsReporting: quorum ? Number(quorum[1]) : null,
    radarsTotal: quorum ? Number(quorum[2]) : null,
  };
}

/** `HH:MMZ` label for the toggle row. */
export function formatScanLabel(validMs) {
  if (!Number.isFinite(validMs)) return null;
  const iso = new Date(validMs).toISOString();
  return `scan ${iso.slice(11, 16)}Z`;
}

/** ICAO for display: TLX → KTLX, Alaska/Hawaii/Guam → P…, Puerto Rico → T…. */
export function radarIcao(site) {
  const prefix = ['AK', 'HI', 'GU'].includes(site.state) ? 'P' : site.state === 'PR' ? 'T' : 'K';
  return `${prefix}${site.id}`;
}

/**
 * IEM's NEXRAD network GeoJSON → online radar sites.
 * @returns {Array<{id: string, name: string, state: string|null, lat: number, lon: number}>}
 */
export function parseRadarSites(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  return features.map((f) => {
    const [lon, lat] = f?.geometry?.coordinates || [];
    const id = String(f?.properties?.sid || f?.id || '');
    return {
      id,
      name: String(f?.properties?.sname || id),
      state: f?.properties?.state || null,
      lat: Number(lat),
      lon: Number(lon),
      online: f?.properties?.online !== false,
    };
  }).filter((s) => s.online && /^[A-Z0-9]{3}$/.test(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map(({ online, ...site }) => site);
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The radar nearest a point, or null when none is within range. */
export function nearestRadarSite(sites, lat, lon, maxKm = SITE_RANGE_KM) {
  let best = null;
  let bestKm = Infinity;
  for (const site of sites) {
    const km = distanceKm(lat, lon, site.lat, site.lon);
    if (km < bestKm) {
      best = site;
      bestKm = km;
    }
  }
  return bestKm <= maxKm ? best : null;
}

/** Globe imagery only — never a 3D tileset (see the module header). */
function imageryTargets(viewer) {
  return viewer?.imageryLayers ? [viewer.imageryLayers] : [];
}

function createProvider(spec) {
  if (spec.site) {
    const latSpan = SITE_RANGE_KM / 111;
    const lonSpan = latSpan / Math.max(0.2, Math.cos((spec.site.lat * Math.PI) / 180));
    return new Cesium.UrlTemplateImageryProvider({
      url: siteTileTemplate(spec.site.id, spec.code, spec.stamp),
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      rectangle: Cesium.Rectangle.fromDegrees(
        spec.site.lon - lonSpan, Math.max(-85, spec.site.lat - latSpan),
        spec.site.lon + lonSpan, Math.min(85, spec.site.lat + latSpan),
      ),
      maximumLevel: SITE_MAX_TILE_LEVEL,
      enablePickFeatures: false,
    });
  }
  const { west, south, east, north } = NEXRAD_COVERAGE_DEG;
  return new Cesium.UrlTemplateImageryProvider({
    url: nexradTileTemplate(spec.stamp),
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
    maximumLevel: NEXRAD_MAX_TILE_LEVEL,
    enablePickFeatures: false,
  });
}

/** Lat/lon at the centre of the view (the camera's sub-point if the centre is sky). */
function viewCenter(viewer) {
  const canvas = viewer?.scene?.canvas;
  let carto = null;
  if (canvas && typeof viewer.camera?.pickEllipsoid === 'function') {
    const hit = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    if (hit) carto = Cesium.Cartographic.fromCartesian(hit);
  }
  carto ??= viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
}

export function createNexradLayer({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  locate = viewCenter,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  /** @type {{key: string, attachments: Array<{collection: any, layer: any}>}|null} */
  let _current = null;
  const _retiring = new Set();
  let _product = 'composite';
  let _meta = null;
  let _site = null;
  let _sites = null;
  let _fallback = false;
  let _noRadar = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _seq = 0;
  let _removeMoveEnd = null;
  let _rowListener = null;

  const detach = (attachments) => {
    for (const { collection, layer } of attachments) {
      if (!collection.isDestroyed?.() && collection.contains(layer)) collection.remove(layer, true);
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

  const show = (spec) => {
    const key = `${spec.site?.id ?? 'US'}|${spec.code ?? 'N0Q'}|${spec.stamp ?? 'latest'}`;
    if (!_viewer || (_current && _current.key === key)) return;
    const attachments = imageryTargets(_viewer).map((collection) => {
      const layer = new Cesium.ImageryLayer(createProvider(spec), { alpha: NEXRAD_LAYER_ALPHA });
      collection.add(layer);
      return { collection, layer };
    });
    const previous = _current;
    _current = { key, attachments };
    if (previous) {
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

  const getJson = async (url, signal) => {
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`IEM HTTP ${response.status}`);
    return response.json();
  };

  async function refreshComposite(signal, seq) {
    let meta = null;
    try {
      meta = parseNexradMeta(await getJson(META_URL, signal));
      _lastError = meta ? null : 'Malformed IEM metadata';
    } catch (error) {
      if (signal?.aborted) throw error;
      _lastError = /^IEM HTTP/.test(error.message) ? error.message : 'IEM network error';
    }
    if (seq !== _seq || !_enabled) return;
    if (meta) {
      _meta = meta;
      _fallback = false;
      _lastUpdate = now();
      show({ stamp: meta.stamp });
    } else if (!_current) {
      // Metadata hiccup with nothing on screen: the tiles are a separate
      // endpoint and usually still fine, so show the rolling composite and
      // report it as a fallback rather than leaving the map empty.
      _fallback = true;
      _lastUpdate = now();
      show({ stamp: null });
      console.warn(`[Data:NEXRAD] ${_lastError}; showing latest composite`);
      _lastError = null;
    }
  }

  async function refreshSite(signal, seq) {
    const product = NEXRAD_PRODUCTS[_product];
    if (!_sites) {
      try {
        _sites = parseRadarSites(await getJson(SITES_URL, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        _lastError = 'radar site list unavailable';
        return;
      }
    }
    const center = locate(_viewer);
    const site = center ? nearestRadarSite(_sites, center.lat, center.lon) : null;
    if (seq !== _seq || !_enabled) return;
    _noRadar = !site;
    if (!site) {
      // Over the ocean / abroad: nothing to show, and say why.
      retireAll();
      _site = null;
      _meta = null;
      _lastError = null;
      return;
    }
    let meta = null;
    try {
      meta = parseNexradMeta(await getJson(SITE_META_URL(site.id, product.code), signal));
      _lastError = meta ? null : 'Malformed IEM metadata';
    } catch (error) {
      if (signal?.aborted) throw error;
      _lastError = null; // tiles may still be fine — fall back to latest below
    }
    if (seq !== _seq || !_enabled) return;
    _site = site;
    _meta = meta;
    _fallback = !meta;
    _lastUpdate = now();
    show({ site, code: product.code, stamp: meta?.stamp ?? null });
  }

  const refresh = async (signal) => {
    const seq = ++_seq;
    if (_product === 'composite') await refreshComposite(signal, seq);
    else await refreshSite(signal, seq);
    _rowListener?.();
  };

  const onMoveEnd = () => {
    if (!_enabled || _product === 'composite' || !_sites) return;
    const center = locate(_viewer);
    const site = center ? nearestRadarSite(_sites, center.lat, center.lon) : null;
    if ((site?.id ?? null) !== (_site?.id ?? null) || (!site) !== _noRadar) void refresh();
  };

  const layer = {
    id: 'nexrad',
    name: 'NEXRAD Radar (US)',
    icon: '🌧️',
    source: 'NOAA NEXRAD via IEM',
    updateInterval: 120_000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _meta = null;
      _fallback = false;
      _lastUpdate = null;
      _lastError = null;
    },

    enable() {
      _enabled = true;
      _removeMoveEnd ??= _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) ?? null;
    },

    disable() {
      _enabled = false;
      _seq += 1;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      retireAll();
    },

    async update(viewer, { signal } = {}) {
      if (!_enabled) return true;
      await refresh(signal);
      return true;
    },

    destroy() {
      layer.disable();
      _viewer = null;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      return {
        chips: Object.entries(NEXRAD_PRODUCTS).map(([id, p]) => ({
          id,
          label: p.chip,
          title: p.title,
          active: _product === id,
          params: { product: id },
        })),
      };
    },

    getParams() {
      return { product: _product };
    },

    setParams(params = {}) {
      if (!Object.hasOwn(NEXRAD_PRODUCTS, params.product)) return false;
      if (params.product !== _product) {
        _product = params.product;
        _meta = null;
        _site = null;
        _noRadar = false;
        _fallback = false;
        _lastError = null;
        if (_enabled) void refresh();
      }
      return true;
    },

    getStats() {
      const scanAgeMs = _meta ? now() - _meta.validMs : null;
      const stale = !_fallback && scanAgeMs !== null && scanAgeMs > NEXRAD_STALE_AFTER_MS;
      const globeHidden = _enabled && _viewer?.scene?.globe?.show === false;
      const product = NEXRAD_PRODUCTS[_product];
      let label;
      if (_product === 'composite') {
        label = _fallback
          ? 'latest composite · scan time unknown'
          : (_meta ? `${formatScanLabel(_meta.validMs)} · ${_meta.radarsReporting ?? '?'}/${_meta.radarsTotal ?? '?'} radars` : '');
      } else if (_noRadar) {
        label = `${product.short} · no radar near the view centre`;
      } else if (_site) {
        const scan = _fallback ? 'latest scan' : formatScanLabel(_meta?.validMs);
        label = `${radarIcao(_site)} ${product.short} · ${scan} · ${_site.name}`;
      } else {
        label = '';
      }
      return {
        count: _product === 'composite' ? (_meta?.radarsReporting ?? 0) : (_site ? 1 : 0),
        lastUpdate: _meta?.validMs ?? _lastUpdate,
        error: _lastError,
        fallback: _fallback,
        stale,
        loadingLabel: label,
        ...(_noRadar ? { status: 'idle' } : {}),
        // Photoreal stack: the globe (radar's only surface) is hidden. A
        // guidance state, not a feed fault.
        ...(globeHidden ? { status: 'idle', loadingLabel: 'switch to a globe map (Esri/OSM) to view radar' } : {}),
      };
    },
  };
  return layer;
}

const nexradLayer = createNexradLayer();

export default nexradLayer;
