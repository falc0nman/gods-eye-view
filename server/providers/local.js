import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { geocodeProxy } from './regional/place.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { localReceiversProxy } from './local-receivers.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { googlePlacesContextProxy } from './places.js';
import { weatherProxy } from './weather.js';
import { cycloneProxy } from './cyclones.js';
import { nexradLevel3Proxy } from './nexrad.js';
import { life360ChasersProxy } from './life360.js';
import { windProxy } from './wind.js';
import { databasePlugin } from './database.js';
import { createProviderRegistry } from './registry.js';
import { registerInterfaceProviders } from './interface.js';

/**
 * Register the local providers in their established order. Providers that
 * implement the common interface (./common/provider.js) use
 * `registry.register(definition)`; the rest are per-layer proxies awaiting
 * migration and are installed unchanged. See docs/DATA-PROVIDERS.md.
 */
function localProviderRegistry({ notificationTransport } = {}) {
  // The interface providers, exactly as the backend registers them.
  const registry = registerInterfaceProviders(createProviderRegistry(), {
    notificationTransport,
  });
  registry.registerLegacy('opensky', openSkyProxy);
  registry.registerLegacy('celestrak', celestrakProxy);
  registry.registerLegacy('tomtom', tomtomProxy);
  registry.registerLegacy('rocket-launches', rocketLaunchesProxy);
  registry.registerLegacy('terrain-heights', terrainHeightsProxy);
  registry.registerLegacy('adsbdb', adsbdbProxy);
  registry.registerLegacy('overpass', overpassProxy);
  registry.registerLegacy('military-installations', militaryInstallationsProxy);
  registry.registerLegacy('geocode', geocodeProxy);
  registry.registerLegacy('cctv', () =>
    cctvProxy({ sourceRoot: defaultSourceRoot }),
  );
  registry.registerLegacy('local-receivers', localReceiversProxy);
  registry.registerLegacy('adsb-lol', adsbLolProxy);
  registry.registerLegacy('ais-live', aisLiveProxy);
  registry.registerLegacy('track-backfill', trackBackfillProxies);
  registry.registerLegacy('openai-realtime', openAiRealtimeProxy);
  registry.registerLegacy('google-places-context', googlePlacesContextProxy);
  registry.registerLegacy('wind', windProxy);
  registry.registerLegacy('weather', weatherProxy);
  registry.registerLegacy('cyclones', cycloneProxy);
  registry.registerLegacy('nexrad-level3', nexradLevel3Proxy);
  registry.registerLegacy('life360-chasers', life360ChasersProxy);
  return registry;
}

/**
 * Construct the local server plugins in their established order: the data
 * providers, then the backend's database plugin (GW-85/86), which is
 * infrastructure rather than a data provider and so is not registered.
 */
function localProviderPlugins() {
  return [...localProviderRegistry().plugins(), databasePlugin()];
}

export { localProviderPlugins, localProviderRegistry };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
