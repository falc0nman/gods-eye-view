import { createOpenFreeMapSource } from '../sources/openFreeMap.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createNexradSource } from '../layers/nexrad/source.js';
import { createNwsWarningsSource } from '../layers/nwsWarnings/source.js';
import { createTeamChasersSource } from '../layers/teamChasers/source.js';
import { createWindSource } from '../layers/wind/source.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  const mapTiles = createOpenFreeMapSource();
  return {
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource({ mapTiles }),
    wind: createWindSource(),
    weather: createWeatherSource(),
    cyclones: createCycloneSource(),
    nexrad: createNexradSource(),
    'nws-warnings': createNwsWarningsSource(),
    'team-chasers': createTeamChasersSource(),
  };
}
