import { sessionToken, sessionCookie } from '../auth.js';
import { identityProviders } from './providers.js';
import {
  opaque,
  digest,
  challenge,
  seal,
  unseal,
  csrf,
  equal,
  authError,
} from './security.js';

/** Audit only structured, non-secret identifiers and reason codes. */
export async function audit(client, actor, action, type, id, metadata = {}) {
  await client.query(
    'INSERT INTO gev.audit_log(actor_id, action, resource_type, resource_id, metadata) VALUES ($1,$2,$3,$4,$5)',
    [actor, action, type, id, JSON.stringify(metadata)],
  );
}

/** Provider-independent application roles; Discord adds mapped roles, never claims. */
async function authorization(client, userId, guildId, discordRoles = []) {
  const roles = (
    await client.query(
      `SELECT role_id FROM gev.user_roles WHERE user_id=$1
    UNION SELECT role_id FROM gev.discord_role_mapping WHERE guild_id=$2 AND discord_role_id=ANY($3::text[])`,
      [userId, guildId || null, discordRoles],
    )
  ).rows
    .map((row) => row.role_id)
    .sort();
  const permissions = (
    await client.query(
      'SELECT DISTINCT permission_id FROM gev.role_permissions WHERE role_id=ANY($1::text[]) ORDER BY permission_id',
      [roles],
    )
  ).rows.map((row) => row.permission_id);
  return { roles, permissions };
}

/** OAuth issuance, provider validation, and revocable live sessions. */
export function createIdentityService({
  pool,
  config,
  providers = identityProviders(config),
}) {
  const cookie = (value, name = config.cookieName, maxAge = 28800) =>
    sessionCookie(value, { name, secure: config.secure, maxAge });
  const clearFlow = () => cookie('a'.repeat(43), config.flowCookie, 0);
  const redirectUri = (provider) =>
    `${config.origin}/auth/${provider}/callback`;
  const attempts = new Map();
  function throttle(req) {
    const minute = Math.floor(Date.now() / 60000);
    for (const [key, value] of attempts)
      if (value.minute !== minute) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const entry = attempts.get(key) || { minute, count: 0 };
    if (entry.count >= 100 || attempts.size >= 1024)
      throw authError('too_many_login_attempts', 429);
    entry.count += 1;
    attempts.set(key, entry);
  }
  async function authenticateSession(req) {
    const token = sessionToken(req.headers.cookie, config.cookieName);
    if (!token || !config.key) return null;
    const hash = digest(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query(
          `SELECT s.*, i.provider, i.subject, i.approved, u.display_name, u.callsign
        FROM gev.sessions s JOIN gev.external_identities i ON i.id=s.identity_id
        JOIN gev.users u ON u.id=s.user_id AND i.user_id=u.id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL AND i.revoked_at IS NULL
        FOR UPDATE OF s`,
          [hash],
        )
      ).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      let discordRoles = [];
      try {
        if (row.provider === 'discord') {
          if (!config.discord.enabled || !row.provider_tokens)
            throw authError('provider_access_revoked');
          let original;
          try {
            original = unseal(row.provider_tokens, config.key, hash);
          } catch {
            throw authError('invalid_session_credentials');
          }
          const current = await providers.revalidate(row.subject, original);
          discordRoles = current.roles;
          if (
            current.tokens.access !== original.access ||
            current.tokens.refresh !== original.refresh ||
            current.tokens.expiresAt !== original.expiresAt
          )
            await client.query(
              'UPDATE gev.sessions SET provider_tokens=$2 WHERE token_hash=$1',
              [hash, seal(current.tokens, config.key, hash)],
            );
        } else if (row.provider !== 'google' || !row.approved)
          throw authError('identity_not_approved');
      } catch (error) {
        if (error.status === 503 || !error.publicCode) throw error;
        await client.query(
          'UPDATE gev.sessions SET revoked_at=now(), provider_tokens=NULL WHERE token_hash=$1',
          [hash],
        );
        await audit(
          client,
          row.user_id,
          'session.revoked',
          'identity',
          row.identity_id,
          { reason: error.publicCode },
        );
        await client.query('COMMIT');
        return null;
      }
      const access = await authorization(
        client,
        row.user_id,
        row.provider === 'discord' ? config.discord.guildId : null,
        discordRoles,
      );
      // Recheck local revocation after the provider network calls.
      const valid = (
        await client.query(
          `SELECT FROM gev.users u JOIN gev.external_identities i ON i.user_id=u.id
        WHERE u.id=$1 AND u.disabled_at IS NULL AND i.id=$2 AND i.revoked_at IS NULL AND (i.provider='discord' OR i.approved)`,
          [row.user_id, row.identity_id],
        )
      ).rowCount;
      if (!valid || !access.roles.length) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      const session = {
        userId: row.user_id,
        displayName: row.display_name,
        callsign: row.callsign,
        expiresAt: row.expires_at,
        ...access,
        csrfToken: csrf(config.key, hash),
      };
      Object.defineProperty(session, 'tokenHash', { value: hash });
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  function authorizeWrite(req, session) {
    return (
      req.headers.origin === config.origin &&
      !['cross-site', 'none'].includes(req.headers['sec-fetch-site']) &&
      equal(req.headers['x-gev-csrf'], session.csrfToken)
    );
  }
  async function start(provider, req) {
    throttle(req);
    if (!config[provider].enabled)
      throw authError('login_provider_disabled', 503);
    const state = opaque(),
      browser = opaque(),
      verifier = opaque(),
      nonce = opaque();
    await pool.query('DELETE FROM gev.oauth_flows WHERE expires_at < now()');
    await pool.query(
      'INSERT INTO gev.oauth_flows(state_hash,browser_hash,provider,verifier,nonce) VALUES ($1,$2,$3,$4,$5)',
      [digest(state), digest(browser), provider, verifier, nonce],
    );
    return {
      status: 303,
      location: providers.authorization(provider, {
        state,
        nonce,
        challenge: challenge(verifier),
        redirectUri: redirectUri(provider),
      }),
      cookies: [cookie(browser, config.flowCookie, 300)],
    };
  }
  async function callback(provider, req) {
    throttle(req);
    if (!config[provider].enabled)
      throw authError('login_provider_disabled', 503);
    const params = new URL(req.url, config.origin).searchParams;
    const state = params.get('state');
    const browser = sessionToken(req.headers.cookie, config.flowCookie);
    async function reject(code) {
      await audit(pool, null, 'login.denied', 'provider', provider, {
        reason: code,
      });
      throw authError(code, 400);
    }
    if (
      params.getAll('state').length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(state || '') ||
      !browser
    )
      return reject('invalid_oauth_state');
    const flow = (
      await pool.query(
        `DELETE FROM gev.oauth_flows WHERE state_hash=$1 AND browser_hash=$2
      AND provider=$3 AND expires_at>now() RETURNING verifier,nonce`,
        [digest(state), digest(browser), provider],
      )
    ).rows[0];
    if (!flow) return reject('invalid_oauth_state');
    if (
      params.has('error') ||
      params.getAll('code').length !== 1 ||
      !params.get('code') ||
      params.get('code').length > 4096
    )
      return reject('login_not_completed');
    let profile;
    try {
      profile = await providers.exchange(provider, params.get('code'), {
        ...flow,
        redirectUri: redirectUri(provider),
      });
    } catch (error) {
      await audit(pool, null, 'login.denied', 'provider', provider, {
        reason: error.publicCode || 'invalid_identity',
      });
      throw error.publicCode ? error : authError('invalid_identity');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`identity:${provider}:${profile.subject}`],
      );
      let identity = (
        await client.query(
          'SELECT * FROM gev.external_identities WHERE provider=$1 AND subject=$2 FOR UPDATE',
          [provider, profile.subject],
        )
      ).rows[0];
      if (identity?.revoked_at) throw authError('identity_revoked', 403);
      if (!identity) {
        const user = (
          await client.query(
            'INSERT INTO gev.users(display_name) VALUES ($1) RETURNING id',
            [profile.displayName],
          )
        ).rows[0];
        identity = (
          await client.query(
            'INSERT INTO gev.external_identities(provider,subject,user_id) VALUES ($1,$2,$3) RETURNING *',
            [provider, profile.subject, user.id],
          )
        ).rows[0];
        if (provider === 'discord')
          await client.query(
            'INSERT INTO gev.discord_identities(discord_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [profile.subject, user.id],
          );
      }
      if (provider === 'google' && !identity.approved) {
        await audit(
          client,
          identity.user_id,
          'login.denied',
          'identity',
          identity.id,
          { reason: 'identity_not_approved' },
        );
        await client.query('COMMIT');
        return {
          status: 403,
          body: { error: 'identity_not_approved' },
          cookies: [clearFlow()],
        };
      }
      const enabled = (
        await client.query(
          'SELECT FROM gev.users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
          [identity.user_id],
        )
      ).rowCount;
      if (!enabled) throw authError('user_disabled', 403);
      const access = await authorization(
        client,
        identity.user_id,
        provider === 'discord' ? config.discord.guildId : null,
        profile.roles || [],
      );
      if (!access.roles.length) throw authError('no_application_access', 403);
      const token = opaque();
      const hash = digest(token);
      const previous = sessionToken(req.headers.cookie, config.cookieName);
      if (previous)
        await client.query(
          'UPDATE gev.sessions SET revoked_at=now(), provider_tokens=NULL WHERE token_hash=$1',
          [digest(previous)],
        );
      await client.query(
        `INSERT INTO gev.sessions(token_hash,user_id,identity_id,provider_tokens,expires_at)
        VALUES ($1,$2,$3,$4,now()+interval '8 hours')`,
        [
          hash,
          identity.user_id,
          identity.id,
          profile.tokens ? seal(profile.tokens, config.key, hash) : null,
        ],
      );
      await audit(
        client,
        identity.user_id,
        'login.succeeded',
        'identity',
        identity.id,
        { provider },
      );
      await client.query('COMMIT');
      return {
        status: 303,
        location: '/',
        cookies: [cookie(token), clearFlow()],
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.publicCode)
        await audit(pool, null, 'login.denied', 'provider', provider, {
          reason: error.publicCode,
        });
      throw error;
    } finally {
      client.release();
    }
  }
  async function logout({ session }) {
    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      row = (
        await client.query(
          `SELECT s.identity_id,s.provider_tokens,i.provider FROM gev.sessions s
        JOIN gev.external_identities i ON i.id=s.identity_id WHERE token_hash=$1 FOR UPDATE OF s`,
          [session.tokenHash],
        )
      ).rows[0];
      await client.query(
        'UPDATE gev.sessions SET revoked_at=now(),provider_tokens=NULL WHERE token_hash=$1',
        [session.tokenHash],
      );
      await audit(
        client,
        session.userId,
        'logout',
        'identity',
        row?.identity_id || null,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (row?.provider === 'discord' && row.provider_tokens) {
      try {
        await providers.revoke(
          unseal(row.provider_tokens, config.key, session.tokenHash),
        );
      } catch {
        /* Local revocation has committed; provider outages cannot restore it. */
      }
    }
    return {
      status: 200,
      body: { signedOut: true },
      cookies: [cookie('a'.repeat(43), config.cookieName, 0)],
    };
  }
  const publicRoutes = [
    {
      method: 'GET',
      path: '/auth/providers',
      handler: async ({ req }) => ({
        status: 200,
        body: {
          discord: config.discord.enabled,
          google: config.google.enabled,
          session: await authenticateSession(req),
        },
      }),
    },
    {
      method: 'GET',
      path: '/auth/login',
      handler: async () => ({
        status: 200,
        html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GEV team sign in</title><body><main><h1>GEV team sign in</h1><p>Use your team identity to access operational workspaces.</p>${config.discord.enabled ? '<p><a href="/auth/discord/login">Continue with Discord</a></p>' : ''}${config.google.enabled ? '<p><a href="/auth/google/login">Continue with Google</a></p>' : ''}${!config.discord.enabled && !config.google.enabled ? '<p>Team sign in is not configured.</p>' : ''}<p><a href="/">Return to the globe</a></p></main></body></html>`,
      }),
    },
    ...['discord', 'google'].flatMap((provider) => [
      {
        method: 'GET',
        path: `/auth/${provider}/login`,
        handler: ({ req }) => start(provider, req),
      },
      {
        method: 'GET',
        path: `/auth/${provider}/callback`,
        handler: ({ req }) => callback(provider, req),
      },
    ]),
  ];
  return {
    authenticateSession,
    authorizeWrite,
    publicRoutes,
    routes: [
      {
        method: 'POST',
        path: '/api/auth/logout',
        permissions: [],
        handler: logout,
      },
    ],
    async denied(session, reason, path) {
      await audit(
        pool,
        session.userId,
        'authorization.denied',
        'route',
        path.slice(0, 200),
        { reason },
      );
    },
  };
}
