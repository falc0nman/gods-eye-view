import flights from '../data/flights.js';
import military from '../data/militaryFlights.js';
import { configureCctvSource } from '../data/cctv.js';
import { configureRadioSource } from '../data/radio.js';
import { configureTrafficSource } from '../data/traffic.js';
import { configureWindSource } from '../data/wind.js';
import { configureMilitaryRegistrySource } from '../data/militaryRegistry.js';
const configure = {
  cctv: configureCctvSource,
  radio: configureRadioSource,
  traffic: configureTrafficSource,
  wind: configureWindSource,
};
/** Configure sources before any registration or state restoration starts. */
export function configureApplicationSources({
  layers = {},
  live = {},
  signal,
  defer,
}) {
  for (const [name, source] of Object.entries(layers)) {
    if (!configure[name]) throw new TypeError(`Unknown layer source: ${name}`);
    defer(configure[name](source));
  }
  if (live.flights) flights.setSource(live.flights);
  if (live.military) {
    military.setSource(live.military);
    defer(configureMilitaryRegistrySource(live.military, { signal }));
  }
}
export const liveLayers = Object.freeze({ flights, military });
