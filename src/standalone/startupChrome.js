import { startApplicationChrome } from '../app/startupChrome.js';
import { initTeamSession } from '../ui/teamSession.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    initializeSettings: initTeamSession,
    ...options,
  });
}
