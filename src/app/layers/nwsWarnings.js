import { createNwsWarningsLayer } from '../../layers/nwsWarnings/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire NWS storm warnings to the application overlay host. */
export function createApplicationNwsWarnings(options) {
  return createNwsWarningsLayer({ overlayHost, ...options });
}
