import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Application layer adapters whose component owners live in a layer folder. */
const LAYER_FOLDERS = Object.freeze({
  'flights.js': '../layers/flights',
  'militaryFlights.js': '../layers/military',
  'aisLiveVessels.js': '../layers/vessels',
  'traffic.js': '../layers/traffic',
  'cctv.js': '../layers/cctv',
});

/** Read actual component owners for structural regression assertions. */
export function readLayerSource(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  const folder = LAYER_FOLDERS[basename(path)];
  if (!folder) return readFileSync(path, 'utf8');
  const directory = join(dirname(path), folder);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n');
}
