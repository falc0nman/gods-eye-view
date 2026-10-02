import { createProviderRegistry } from './registry.js';
import { createNotificationDispatcher } from './notifications/dispatcher.js';
import { unconfiguredTransport } from './notifications/transport.js';
import { nexradLevel2Provider } from './nexrad-level2.js';
import { createHealthRecorder } from './common/healthStore.js';

/**
 * The providers on the common interface (GW-80), registered the same way for
 * the standalone backend (GW-86) and the Vite dev server, so both serve the
 * same routes. Legacy per-layer proxies are not here: they stay dev-only
 * until GW-53 decides which survive (docs/BACKEND.md).
 *
 * @param {ReturnType<typeof createProviderRegistry>} registry
 * @param {{notificationTransport?: {start: Function}}} [options]
 */
export function registerInterfaceProviders(
  registry,
  { notificationTransport } = {},
) {
  // NOAA new-object notifications (GW-81). The SNS → SQS consumer is supplied
  // by the backend; without one, feeds poll.
  const dispatcher = createNotificationDispatcher({
    transport: notificationTransport ?? unconfiguredTransport(),
  });
  registry.registerStream('notifications', dispatcher.status);
  registry.register(nexradLevel2Provider({ dispatcher }));
  return registry;
}

/**
 * Provider routes and lifecycle for `backend/main.js`.
 *
 * - `routes`: backend route declarations; `createBackend` gates every one
 *   behind a live session and its permissions (GW-45).
 * - `start()`: background health evaluation, recorded to `gev.feed_health`
 *   through the backend's `gev_app` pool (GW-85).
 * - `close()`: stops ingest, timers and the recorder on shutdown.
 */
export function backendProviders({ pool, notificationTransport, logger } = {}) {
  const registry = registerInterfaceProviders(createProviderRegistry(), {
    notificationTransport,
  });
  let recorder = null;
  return {
    registry,
    routes: registry.apiRoutes(),
    start() {
      if (pool && !recorder)
        recorder = createHealthRecorder({
          pool,
          monitor: registry.health,
          logger,
        });
      registry.health.start();
    },
    async close() {
      registry.close();
      await recorder?.stop();
    },
  };
}
