import { createTeamChasersLayer } from '../../layers/teamChasers/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire Life360 team chaser positions to the application overlay host. */
export function createApplicationTeamChasers(options) {
  return createTeamChasersLayer({ overlayHost, ...options });
}
