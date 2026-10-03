import { RADIO_UUID_RE } from './policy.js';

/**
 * GW-57 removed the Radio Browser directory. GW-78 decides the replacement;
 * until then the radio UI keeps working against this stub, which never
 * touches the network and reports that no directory is configured.
 */
export const RADIO_DIRECTORY_UNCONFIGURED = 'No radio directory is configured';

/** Supply directory metadata and click reporting; audio stays with the broadcaster. */
export function createRadioSource() {
  return {
    async getDirectory({ signal } = {}) {
      signal?.throwIfAborted();
      throw new Error(RADIO_DIRECTORY_UNCONFIGURED);
    },
    async recordClick(id, { signal } = {}) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id))
        throw new Error('Invalid radio station id');
      signal?.throwIfAborted();
    },
  };
}
