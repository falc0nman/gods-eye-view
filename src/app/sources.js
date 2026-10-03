import { configureCctvSource } from '../data/cctv.js';
import { configureRadioSource } from '../data/radio.js';
import { configureTrafficSource } from '../data/traffic.js';
import { configureWindSource } from '../data/wind.js';
const configure = {
  cctv: configureCctvSource,
  radio: configureRadioSource,
  traffic: configureTrafficSource,
  wind: configureWindSource,
};
/** Configure sources before any registration or state restoration starts. */
export function configureApplicationSources({ layers = {}, defer }) {
  for (const [name, source] of Object.entries(layers)) {
    if (!configure[name]) throw new TypeError(`Unknown layer source: ${name}`);
    defer(configure[name](source));
  }
}
