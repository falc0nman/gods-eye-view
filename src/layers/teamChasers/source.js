import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * Team chasers — acquisition. Positions, the picker roster and selection
 * saves all go to this app's server (server/providers/life360.js), which
 * holds the Life360 token; the browser only ever sees first name, position,
 * fix time and battery. No rendering here.
 */

const LIMIT = 256 * 1024;

/** Validate the server payload into chasers the layer can draw. */
export function normalizeChasers(payload) {
  const list = Array.isArray(payload?.chasers) ? payload.chasers : [];
  return list
    .filter(
      (c) =>
        Number.isFinite(c?.lat) &&
        Number.isFinite(c?.lon) &&
        Math.abs(c.lat) <= 90 &&
        Math.abs(c.lon) <= 180,
    )
    .map((c) => ({
      id: String(c.id ?? c.name),
      name: String(c.name || '?').slice(0, 32),
      lat: c.lat,
      lon: c.lon,
      fixMs: Number.isFinite(c.fixMs) ? c.fixMs : null,
      battery: Number.isFinite(c.battery) ? c.battery : null,
    }));
}

/** Human message for a failed picker request. */
export function pickerErrorText(status, payload) {
  if (status === 403)
    return 'The picker only works on the machine running the server.';
  if (payload?.configured === false) return 'Add LIFE360_TOKEN to .env first.';
  return payload?.error || `Request failed (HTTP ${status}).`;
}

/** Lazy acquisition; owns only request deadlines and cancellation. */
export function createTeamChasersSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  async function request(url, init = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Chaser request timed out')),
      timeoutMs,
    );
    try {
      init.signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const payload = await readResponseJsonCapped(
        response,
        LIMIT,
        controller.signal,
      ).catch(() => null);
      return { response, payload };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  }
  return {
    /** @returns {Promise<{configured: boolean, health: object|null, chasers: Array<object>}>} */
    async getSnapshot({ signal } = {}) {
      const { response, payload } = await request('/api/chasers', { signal });
      if (!response.ok || !payload)
        throw new Error(`chaser bridge HTTP ${response.status}`);
      const configured = payload.configured !== false;
      return {
        configured,
        health:
          configured &&
          payload.health &&
          typeof payload.health.state === 'string'
            ? payload.health
            : null,
        chasers: configured ? normalizeChasers(payload) : [],
      };
    },
    /** Picker roster; throws with an instruction-style message. */
    async getRoster() {
      const { response, payload } = await request('/api/chasers/roster');
      if (!response.ok || !payload || payload.configured === false) {
        throw new Error(pickerErrorText(response.status, payload));
      }
      return payload;
    },
    /** Save `{ids}` (empty = everyone) or `{reset: true}`. */
    async saveSelection(body) {
      const { response, payload } = await request('/api/chasers/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok || !payload || payload.configured === false) {
        throw new Error(pickerErrorText(response.status, payload));
      }
      return payload;
    },
  };
}
