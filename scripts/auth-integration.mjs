import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createDatabasePool } from '../server/database/connection.js';
import { createBackend } from '../backend/server.js';
import { identityConfig } from '../backend/identity/config.js';
import { createIdentityService } from '../backend/identity/service.js';
import {
  administrationRoutes,
  approveIdentity,
  authorizeWorkspace,
} from '../backend/identity/administration.js';
import {
  opaque,
  digest,
  authError,
  unseal,
} from '../backend/identity/security.js';

// Real PostgreSQL, HTTP, transactions and cookies; only external identity providers are fixtures.
const pool = createDatabasePool(),
  owner = createDatabasePool({ migrate: true });
const prefix = `qa-auth-${randomUUID()}`,
  subject = String(Date.now()),
  guild = String(Date.now() + 1000);
const config = identityConfig({
  GEV_PUBLIC_ORIGIN: 'http://localhost:4195',
  GEV_AUTH_KEY: 'cd'.repeat(32),
  GEV_DISCORD_CLIENT_ID: 'fixture',
  GEV_DISCORD_CLIENT_SECRET: 'fixture-client-secret',
  GEV_DISCORD_BOT_TOKEN: 'fixture-bot-secret',
  GEV_DISCORD_GUILD_ID: guild,
  GEV_GOOGLE_CLIENT_ID: 'fixture',
  GEV_GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
});
let liveRoles = ['111', '222'],
  providerFailure = null,
  issuedGoogle = `${prefix}-google`,
  revoked = false,
  exchanges = 0;
const tokens = {
  access: 'fixture-private-access',
  refresh: 'fixture-private-refresh',
  expiresAt: Date.now() + 3600000,
};
const providers = {
  authorization: (_provider, values) =>
    `https://provider.example/authorize?${new URLSearchParams(values)}`,
  async exchange(provider) {
    exchanges++;
    if (providerFailure) throw providerFailure;
    return provider === 'google'
      ? { subject: issuedGoogle, displayName: 'Google test' }
      : { subject, displayName: 'Discord test', roles: liveRoles, tokens };
  },
  async revalidate() {
    if (providerFailure) throw providerFailure;
    return { roles: liveRoles, tokens };
  },
  async revoke() {
    revoked = true;
  },
};
const service = createIdentityService({ pool, config, providers });
const sensitive = [
  'target:designate',
  'annotations:write',
  'handoff:write',
  'position:write',
  'team:admin',
  'broadcast:control',
  'configuration:write',
];
let writes = 0;
const server = createBackend({
  pool,
  identityService: service,
  publicOrigin: config.origin,
  logger: { error() {} },
  routes: [
    ...administrationRoutes(pool, config),
    ...sensitive.map((permission, index) => ({
      method: 'POST',
      path: `/api/qa/action-${index}`,
      permissions: [permission],
      async handler() {
        writes++;
        return { status: 200, body: { ok: true } };
      },
    })),
  ],
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`,
  users = new Set(),
  workspaces = [];
function request(
  path,
  {
    method = 'GET',
    cookie,
    body,
    csrfToken,
    origin = config.origin,
    headers = {},
  } = {},
) {
  return fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-GEV-CSRF': csrfToken } : {}),
      ...(method !== 'GET' ? { Origin: origin } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
}
async function flow(provider = 'discord') {
  const response = await request(`/auth/${provider}/login`);
  assert.equal(response.status, 303);
  const state = new URL(response.headers.get('location')).searchParams.get(
    'state',
  );
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  assert.match(response.headers.getSetCookie()[0], /HttpOnly/);
  assert.match(response.headers.getSetCookie()[0], /SameSite=Lax/);
  return {
    state,
    cookie,
    path: `/auth/${provider}/callback?code=fixture-code&state=${state}`,
  };
}
async function login(provider = 'discord') {
  const f = await flow(provider),
    response = await request(f.path, { cookie: f.cookie });
  assert.equal(response.status, 303, await response.clone().text());
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith('gev_session='))
    .split(';')[0];
  const session = await (await request('/api/session', { cookie })).json();
  users.add(session.userId);
  return { cookie, session };
}
async function approve(provider, sub, roles, userId) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE gev_owner');
    const id = await approveIdentity(client, {
      provider,
      subject: sub,
      grantedRoles: roles,
      userId,
    });
    await client.query('COMMIT');
    users.add(id);
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
try {
  for (const path of [
    '/api/session',
    '/api/admin/users',
    '/api/setup/status',
    '/api/setup/keys',
  ])
    assert.equal((await request(path)).status, 401);
  assert.equal(
    (
      await request('/api/session', {
        headers: { 'X-User-Id': randomUUID(), 'X-Role': 'administrator' },
      })
    ).status,
    401,
  );
  const f = await flow(),
    before = exchanges;
  assert.equal(
    (await request(f.path, { method: 'HEAD', cookie: f.cookie })).status,
    405,
  );
  assert.equal(
    (await request(f.path, { cookie: `gev_oauth=${opaque()}` })).status,
    400,
  );
  assert.equal(
    (await request(f.path + '&state=' + f.state, { cookie: f.cookie })).status,
    400,
  );
  assert.equal(
    (
      await request(f.path.replace('/discord/', '/google/'), {
        cookie: f.cookie,
      })
    ).status,
    400,
  );
  assert.equal(exchanges, before);
  await pool.query(
    "UPDATE gev.oauth_flows SET expires_at=now()-interval '1 minute' WHERE state_hash=$1",
    [digest(f.state)],
  );
  assert.equal((await request(f.path, { cookie: f.cookie })).status, 400);
  console.log(
    'PASS: anonymous denial, forged headers, OAuth state/browser/provider binding, duplicate state, expiry and HEAD refusal',
  );

  const adminSubject = `${prefix}-admin`;
  await approve('google', adminSubject, ['administrator']);
  issuedGoogle = adminSubject;
  const admin = await login('google');
  let r = await request('/api/admin/discord-role-mapping', {
    method: 'PUT',
    cookie: admin.cookie,
    csrfToken: admin.session.csrfToken,
    body: { mapping: { 111: ['forecaster'], 222: ['chaser'] } },
  });
  assert.equal(r.status, 200);
  const discord = await login();
  assert.deepEqual(discord.session.roles, ['chaser', 'forecaster']);
  assert.ok(discord.session.permissions.includes('target:designate'));
  assert.equal(discord.session.permissions.includes('roles:admin'), false);
  const stored = (
    await pool.query(
      'SELECT token_hash,provider_tokens FROM gev.sessions WHERE user_id=$1',
      [discord.session.userId],
    )
  ).rows[0];
  assert.equal(stored.provider_tokens.includes(tokens.access), false);
  assert.equal(stored.token_hash.includes(discord.cookie.split('=')[1]), false);
  assert.equal(
    JSON.stringify(discord.session).includes(stored.token_hash),
    false,
  );
  assert.equal(JSON.stringify(discord.session).includes(tokens.access), false);
  // Refresh token rotation may keep the same access token; retain the new refresh token.
  tokens.refresh = 'fixture-rotated-refresh';
  tokens.expiresAt += 60000;
  assert.equal(
    (await request('/api/session', { cookie: discord.cookie })).status,
    200,
  );
  const updated = (
    await pool.query(
      'SELECT provider_tokens FROM gev.sessions WHERE token_hash=$1',
      [stored.token_hash],
    )
  ).rows[0];
  assert.equal(
    unseal(updated.provider_tokens, config.key, stored.token_hash).refresh,
    tokens.refresh,
  );
  liveRoles = ['222'];
  assert.deepEqual(
    (await (await request('/api/session', { cookie: discord.cookie })).json())
      .roles,
    ['chaser'],
  );
  assert.equal(
    (
      await request('/api/qa/action-0', {
        method: 'POST',
        cookie: discord.cookie,
        csrfToken: discord.session.csrfToken,
        body: {},
        headers: { 'X-Role': 'administrator' },
      })
    ).status,
    403,
  );
  providerFailure = authError('identity_provider_unavailable', 503);
  assert.equal(
    (await request('/api/session', { cookie: discord.cookie })).status,
    503,
  );
  providerFailure = null;
  assert.equal(
    (await request('/api/session', { cookie: discord.cookie })).status,
    200,
  );
  providerFailure = authError('guild_membership_required', 403);
  assert.equal(
    (await request('/api/session', { cookie: discord.cookie })).status,
    401,
  );
  providerFailure = null;
  assert.equal(
    (await request('/api/session', { cookie: discord.cookie })).status,
    401,
  );
  console.log(
    'PASS: encrypted Discord tokens, union of stable role IDs, immediate role refresh, no header escalation, fail-closed provider outage and guild departure',
  );

  issuedGoogle = `${prefix}-google`;
  const googleFlow = await flow('google');
  assert.equal(
    (await request(googleFlow.path, { cookie: googleFlow.cookie })).status,
    403,
  );
  assert.equal(
    (await request(googleFlow.path, { cookie: googleFlow.cookie })).status,
    400,
  );
  const pending = (
    await pool.query(
      'SELECT user_id,approved FROM gev.external_identities WHERE subject=$1',
      [issuedGoogle],
    )
  ).rows[0];
  users.add(pending.user_id);
  assert.equal(pending.approved, false);
  r = await request('/api/admin/identities', {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.session.csrfToken,
    body: {
      provider: 'google',
      subject: issuedGoogle,
      userId: discord.session.userId,
      roles: ['viewer'],
    },
  });
  assert.equal(r.status, 200, await r.clone().text());
  const linked = await login('google');
  assert.equal(linked.session.userId, discord.session.userId);
  assert.deepEqual(linked.session.roles, ['viewer']);
  assert.equal(
    (
      await request('/api/admin/users', {
        cookie: linked.cookie,
        headers: { 'X-Role': 'administrator' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/admin/users', { cookie: admin.cookie })).status,
    200,
  );
  assert.equal(
    (
      await request('/api/admin/revoke-sessions', {
        method: 'POST',
        cookie: admin.cookie,
        body: { userId: linked.session.userId },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/admin/revoke-sessions', {
        method: 'POST',
        cookie: admin.cookie,
        csrfToken: admin.session.csrfToken,
        origin: 'https://attacker.example',
        body: { userId: linked.session.userId },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/admin/user-roles', {
        method: 'PUT',
        cookie: admin.cookie,
        csrfToken: admin.session.csrfToken,
        body: { userId: admin.session.userId, roles: ['viewer'] },
      })
    ).status,
    409,
  );
  const workspace = (
    await pool.query(
      "INSERT INTO gev.workspaces(name) VALUES ('Auth QA') RETURNING id",
    )
  ).rows[0].id;
  workspaces.push(workspace);
  assert.equal(
    await authorizeWorkspace(pool, linked.session, workspace, 'workspace:read'),
    false,
  );
  await pool.query(
    "INSERT INTO gev.workspace_members(workspace_id,user_id,role_id) VALUES ($1,$2,'viewer')",
    [workspace, linked.session.userId],
  );
  assert.equal(
    await authorizeWorkspace(pool, linked.session, workspace, 'workspace:read'),
    true,
  );
  assert.equal(
    await authorizeWorkspace(
      pool,
      linked.session,
      workspace,
      'target:designate',
    ),
    false,
  );
  assert.equal(
    await authorizeWorkspace(
      pool,
      admin.session,
      workspace,
      'target:designate',
    ),
    true,
  );
  console.log(
    'PASS: Google login remains unapproved, explicit cross-provider linking, Google identity has no implicit Discord privilege, CSRF and workspace boundaries',
  );

  // Verify every operational permission for every role through the HTTP gateway.
  const permitted = {
    administrator: sensitive,
    forecaster: [
      'target:designate',
      'annotations:write',
      'handoff:write',
      'broadcast:control',
    ],
    chaser: ['annotations:write', 'handoff:write', 'position:write'],
    support: ['annotations:write', 'handoff:write'],
    viewer: [],
  };
  for (const [role, allowed] of Object.entries(permitted)) {
    await pool.query('DELETE FROM gev.user_roles WHERE user_id=$1', [
      linked.session.userId,
    ]);
    await pool.query(
      'INSERT INTO gev.user_roles(user_id,role_id) VALUES ($1,$2)',
      [linked.session.userId, role],
    );
    for (const [index, permission] of sensitive.entries())
      assert.equal(
        (
          await request(`/api/qa/action-${index}`, {
            method: 'POST',
            cookie: linked.cookie,
            csrfToken: linked.session.csrfToken,
            body: {},
          })
        ).status,
        allowed.includes(permission) ? 200 : 403,
        `${role}: ${permission}`,
      );
  }
  assert.ok(writes > 0);
  await pool.query(
    "UPDATE gev.user_roles SET role_id='viewer' WHERE user_id=$1",
    [linked.session.userId],
  );
  r = await request('/api/profile', {
    method: 'PATCH',
    cookie: linked.cookie,
    csrfToken: linked.session.csrfToken,
    body: { callsign: 'FIELD-1' },
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await (await request('/api/session', { cookie: linked.cookie })).json())
      .callsign,
    'FIELD-1',
  );
  const originalHash = digest(linked.cookie.split('=')[1]);
  await pool.query(
    "UPDATE gev.sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE token_hash=$1",
    [originalHash],
  );
  assert.equal(
    (await request('/api/session', { cookie: linked.cookie })).status,
    401,
  );
  const rotating = await login('google'),
    rotateFlow = await flow('google');
  r = await request(rotateFlow.path, {
    cookie: `${rotateFlow.cookie}; ${rotating.cookie}`,
  });
  assert.equal(r.status, 303);
  assert.equal(
    (await request('/api/session', { cookie: rotating.cookie })).status,
    401,
  );
  const logged = await login();
  assert.equal(
    (
      await request('/api/auth/logout', {
        method: 'POST',
        cookie: logged.cookie,
        csrfToken: logged.session.csrfToken,
      })
    ).status,
    200,
  );
  assert.equal(revoked, true);
  assert.equal(
    (await request('/api/session', { cookie: logged.cookie })).status,
    401,
  );
  console.log(
    'PASS: all five role boundaries, callsign, expired sessions, session rotation and logout revocation',
  );

  const google = await login('google');
  await request('/api/admin/revoke-identity', {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.session.csrfToken,
    body: { provider: 'google', subject: issuedGoogle },
  });
  assert.equal(
    (await request('/api/session', { cookie: google.cookie })).status,
    401,
  );
  const deniedFlow = await flow('google');
  assert.equal(
    (await request(deniedFlow.path, { cookie: deniedFlow.cookie })).status,
    403,
  );
  const currentDiscord = await login();
  assert.equal(
    (
      await request('/api/admin/disable-user', {
        method: 'POST',
        cookie: admin.cookie,
        csrfToken: admin.session.csrfToken,
        body: { userId: currentDiscord.session.userId },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/api/session', { cookie: currentDiscord.cookie })).status,
    401,
  );
  const events = (
    await (await request('/api/admin/audit', { cookie: admin.cookie })).json()
  ).events;
  for (const action of [
    'login.succeeded',
    'login.denied',
    'logout',
    'authorization.denied',
    'discord.mapping.changed',
    'identity.approved',
    'identity.linked',
    'identity.revoked',
    'user.disabled',
  ])
    assert.ok(
      events.some((event) => event.action === action),
      action,
    );
  const auditText = JSON.stringify(events);
  for (const secret of [
    tokens.access,
    tokens.refresh,
    admin.cookie.split('=')[1],
    originalHash,
    'fixture-client-secret',
    'fixture-code',
  ])
    assert.equal(auditText.includes(secret), false);
  assert.equal(
    (
      await request('/api/setup/keys', {
        method: 'POST',
        cookie: admin.cookie,
        csrfToken: admin.session.csrfToken,
        body: { OPENAI_API_KEY: 'unaccepted' },
      })
    ).status,
    403,
  );
  console.log(
    'PASS: identity revocation, disabled users, secret-free security audits and no credential-writing endpoint',
  );
  console.log('Authentication integration checks passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const id of workspaces)
    await pool.query('DELETE FROM gev.workspaces WHERE id=$1', [id]);
  // Clean only identities/users created by this invocation; preserve audit history.
  for (const id of users)
    await pool.query('DELETE FROM gev.users WHERE id=$1', [id]);
  await pool.query('DELETE FROM gev.discord_role_mapping WHERE guild_id=$1', [
    guild,
  ]);
  await Promise.all([pool.end(), owner.end()]);
}
