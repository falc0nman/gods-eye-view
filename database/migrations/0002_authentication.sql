CREATE TABLE gev.external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('discord', 'google')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES gev.users ON DELETE CASCADE,
  approved boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, subject)
);
CREATE INDEX external_identities_user_idx ON gev.external_identities(user_id);
INSERT INTO gev.external_identities(provider, subject, user_id)
  SELECT 'discord', discord_id, user_id FROM gev.discord_identities;
ALTER TABLE gev.users ADD COLUMN callsign text CHECK (length(callsign) <= 80);
ALTER TABLE gev.sessions ADD COLUMN identity_id uuid REFERENCES gev.external_identities ON DELETE CASCADE;
ALTER TABLE gev.sessions ADD COLUMN provider_tokens text;
CREATE INDEX sessions_identity_idx ON gev.sessions(identity_id);
CREATE TABLE gev.oauth_flows (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('discord', 'google')),
  verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX oauth_flows_expiry_idx ON gev.oauth_flows(expires_at);
CREATE TABLE gev.discord_role_mapping (
  guild_id text NOT NULL CHECK (guild_id ~ '^[0-9]{1,20}$'),
  discord_role_id text NOT NULL CHECK (discord_role_id ~ '^[0-9]{1,20}$'),
  role_id text NOT NULL REFERENCES gev.roles ON DELETE CASCADE,
  PRIMARY KEY(guild_id, discord_role_id, role_id)
);
INSERT INTO gev.roles(id, description) VALUES
  ('administrator', 'Administration and emergency access'),
  ('forecaster', 'Forecast desk and operational designation'),
  ('chaser', 'Chase observations and own position'),
  ('support', 'Chase assistance and handoffs'),
  ('viewer', 'Read-only broadcast access') ON CONFLICT DO NOTHING;
INSERT INTO gev.permissions(id, description) VALUES
  ('system:read', 'Read service health'), ('workspace:read', 'Read authorized workspaces'),
  ('workspace:write', 'Edit authorized shared state'), ('target:designate', 'Designate operational targets'),
  ('annotations:write', 'Edit authorized annotations'), ('handoff:write', 'Transfer operational work'),
  ('position:write', 'Publish own team position'), ('team:read', 'Read team positions'),
  ('team:admin', 'Administer team membership'), ('broadcast:read', 'Read broadcast state'),
  ('broadcast:control', 'Control broadcasts'), ('configuration:write', 'Change configuration'),
  ('identities:admin', 'Approve identities and disable users'), ('roles:admin', 'Change roles and mappings'),
  ('audit:read', 'Read security audit'), ('feed:read', 'Read authorized feeds') ON CONFLICT DO NOTHING;
INSERT INTO gev.role_permissions SELECT 'administrator', id FROM gev.permissions ON CONFLICT DO NOTHING;
INSERT INTO gev.role_permissions(role_id, permission_id) VALUES
  ('forecaster','system:read'), ('forecaster','workspace:read'), ('forecaster','workspace:write'),
  ('forecaster','target:designate'), ('forecaster','annotations:write'), ('forecaster','handoff:write'),
  ('forecaster','team:read'), ('forecaster','broadcast:read'), ('forecaster','broadcast:control'), ('forecaster','feed:read'),
  ('chaser','workspace:read'), ('chaser','annotations:write'), ('chaser','handoff:write'),
  ('chaser','position:write'), ('chaser','team:read'), ('chaser','feed:read'),
  ('support','workspace:read'), ('support','annotations:write'), ('support','handoff:write'),
  ('support','team:read'), ('support','feed:read'),
  ('viewer','workspace:read'), ('viewer','broadcast:read'), ('viewer','feed:read') ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON gev.external_identities, gev.oauth_flows, gev.discord_role_mapping TO gev_app;
CREATE OR REPLACE FUNCTION gev.prune_history() RETURNS void LANGUAGE plpgsql AS $$
DECLARE policy gev.retention_policy;
BEGIN
  SELECT * INTO STRICT policy FROM gev.retention_policy WHERE singleton;
  DELETE FROM gev.team_positions WHERE observed_at < now() - make_interval(days => policy.position_days);
  DELETE FROM gev.feed_health WHERE observed_at < now() - make_interval(days => policy.health_days);
  DELETE FROM gev.sessions WHERE expires_at < now();
  DELETE FROM gev.oauth_flows WHERE expires_at < now();
END;
$$;
