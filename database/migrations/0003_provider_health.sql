-- GW-83: provider health reports `stale` (data older than its product's
-- threshold) separately from `degraded` (late or failing intermittently).
ALTER TABLE gev.feed_health DROP CONSTRAINT feed_health_status_check;
ALTER TABLE gev.feed_health ADD CONSTRAINT feed_health_status_check
  CHECK (status IN ('healthy', 'degraded', 'stale', 'unavailable', 'disabled'));

-- One shared (workspace-less) feed row per provider product, so the backend
-- can upsert its own feeds without duplicating them.
CREATE UNIQUE INDEX feeds_shared_provider_name_idx
  ON gev.feeds (provider, name) WHERE workspace_id IS NULL;
