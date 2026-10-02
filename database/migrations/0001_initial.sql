-- Bulk radar, imagery and recordings remain in object storage; only URIs belong here.
CREATE TABLE gev.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gev.discord_identities (
  discord_id text PRIMARY KEY CHECK (discord_id ~ '^[0-9]+$'),
  user_id uuid NOT NULL UNIQUE REFERENCES gev.users ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gev.roles (id text PRIMARY KEY, description text NOT NULL);
CREATE TABLE gev.permissions (id text PRIMARY KEY, description text NOT NULL);
CREATE TABLE gev.role_permissions (
  role_id text REFERENCES gev.roles ON DELETE CASCADE,
  permission_id text REFERENCES gev.permissions ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE gev.user_roles (
  user_id uuid REFERENCES gev.users ON DELETE CASCADE,
  role_id text REFERENCES gev.roles ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE gev.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES gev.users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON gev.sessions(user_id);
CREATE INDEX sessions_expiry_idx ON gev.sessions(expires_at);
CREATE TABLE gev.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES gev.users ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON gev.audit_log(occurred_at);
CREATE TABLE gev.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES gev.users ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gev.workspace_members (
  workspace_id uuid REFERENCES gev.workspaces ON DELETE CASCADE,
  user_id uuid REFERENCES gev.users ON DELETE CASCADE,
  role_id text NOT NULL REFERENCES gev.roles,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE gev.targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES gev.workspaces ON DELETE CASCADE,
  label text NOT NULL,
  location geometry(Point, 4326) NOT NULL,
  created_by uuid REFERENCES gev.users ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX targets_spatial_idx ON gev.targets USING gist(location);
CREATE INDEX targets_workspace_idx ON gev.targets(workspace_id);
CREATE TABLE gev.annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES gev.workspaces ON DELETE CASCADE,
  author_id uuid REFERENCES gev.users ON DELETE SET NULL,
  body text NOT NULL DEFAULT '',
  shape geometry(Geometry, 4326) NOT NULL CHECK (ST_IsValid(shape)),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX annotations_spatial_idx ON gev.annotations USING gist(shape);
CREATE INDEX annotations_workspace_idx ON gev.annotations(workspace_id);
CREATE TABLE gev.handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES gev.workspaces ON DELETE CASCADE,
  target_id uuid REFERENCES gev.targets ON DELETE SET NULL,
  from_user_id uuid REFERENCES gev.users ON DELETE SET NULL,
  to_user_id uuid REFERENCES gev.users ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoffs_workspace_idx ON gev.handoffs(workspace_id);
CREATE TABLE gev.team_positions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES gev.workspaces ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES gev.users ON DELETE CASCADE,
  location geometry(Point, 4326) NOT NULL,
  observed_at timestamptz NOT NULL,
  accuracy_m double precision CHECK (accuracy_m >= 0),
  source text NOT NULL,
  UNIQUE (workspace_id, user_id, observed_at, source)
);
CREATE INDEX team_positions_spatial_idx ON gev.team_positions USING gist(location);
CREATE INDEX team_positions_user_time_idx ON gev.team_positions(workspace_id, user_id, observed_at DESC);
CREATE INDEX team_positions_retention_idx ON gev.team_positions(observed_at);
CREATE TABLE gev.feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES gev.workspaces ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stream', 'camera', 'weather', 'position', 'other')),
  provider text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  credential_ref text,
  enabled boolean NOT NULL DEFAULT true,
  media_uri text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN gev.feeds.config IS 'Non-secret settings only. Credentials resolve server-side through credential_ref (GW-84).';
COMMENT ON COLUMN gev.feeds.media_uri IS 'Pointer to disk/object storage; never a media payload or signed URL.';
CREATE INDEX feeds_workspace_idx ON gev.feeds(workspace_id);
CREATE TABLE gev.cameras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id uuid REFERENCES gev.feeds ON DELETE SET NULL,
  name text NOT NULL,
  location geometry(Point, 4326) NOT NULL,
  attribution text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX cameras_spatial_idx ON gev.cameras USING gist(location);
CREATE INDEX cameras_feed_idx ON gev.cameras(feed_id);
CREATE TABLE gev.feed_health (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_id uuid NOT NULL REFERENCES gev.feeds ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'unavailable', 'disabled')),
  latency_ms integer CHECK (latency_ms >= 0),
  reason_code text
);
CREATE INDEX feed_health_feed_time_idx ON gev.feed_health(feed_id, observed_at DESC);
CREATE INDEX feed_health_retention_idx ON gev.feed_health(observed_at);

-- Operators own policy; the runtime cannot shorten history retention.
CREATE TABLE gev.retention_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  position_days integer NOT NULL DEFAULT 30 CHECK (position_days BETWEEN 1 AND 3650),
  health_days integer NOT NULL DEFAULT 30 CHECK (health_days BETWEEN 1 AND 3650)
);
INSERT INTO gev.retention_policy DEFAULT VALUES;
CREATE FUNCTION gev.prune_history() RETURNS void LANGUAGE plpgsql AS $$
DECLARE policy gev.retention_policy;
BEGIN
  SELECT * INTO STRICT policy FROM gev.retention_policy WHERE singleton;
  DELETE FROM gev.team_positions WHERE observed_at < now() - make_interval(days => policy.position_days);
  DELETE FROM gev.feed_health WHERE observed_at < now() - make_interval(days => policy.health_days);
  DELETE FROM gev.sessions WHERE expires_at < now();
END;
$$;
REVOKE ALL ON FUNCTION gev.prune_history() FROM PUBLIC;
GRANT USAGE ON SCHEMA gev TO gev_app;
GRANT SELECT ON ALL TABLES IN SCHEMA gev TO gev_app;
GRANT INSERT, UPDATE, DELETE ON gev.users, gev.discord_identities, gev.roles,
  gev.permissions, gev.role_permissions, gev.user_roles, gev.sessions,
  gev.workspaces, gev.workspace_members, gev.targets, gev.annotations,
  gev.handoffs, gev.team_positions, gev.feeds, gev.cameras, gev.feed_health TO gev_app;
GRANT INSERT ON gev.audit_log TO gev_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gev TO gev_app;

-- Notifications are invalidation hints, never private records; consumers re-query
-- after authorization. NOTIFY is delivered only after a successful commit.
CREATE FUNCTION gev.notify_workspace_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('gev_workspace_changes', json_build_object(
    'table', TG_TABLE_NAME, 'operation', TG_OP,
    'workspace_id', COALESCE(NEW.workspace_id, OLD.workspace_id))::text);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION gev.notify_workspace_change() FROM PUBLIC;
CREATE TRIGGER targets_changed AFTER INSERT OR UPDATE OR DELETE ON gev.targets
  FOR EACH ROW EXECUTE FUNCTION gev.notify_workspace_change();
CREATE TRIGGER annotations_changed AFTER INSERT OR UPDATE OR DELETE ON gev.annotations
  FOR EACH ROW EXECUTE FUNCTION gev.notify_workspace_change();
CREATE TRIGGER handoffs_changed AFTER INSERT OR UPDATE OR DELETE ON gev.handoffs
  FOR EACH ROW EXECUTE FUNCTION gev.notify_workspace_change();
CREATE TRIGGER memberships_changed AFTER INSERT OR UPDATE OR DELETE ON gev.workspace_members
  FOR EACH ROW EXECUTE FUNCTION gev.notify_workspace_change();
