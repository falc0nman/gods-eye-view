import { audit } from './service.js';
import { authError } from './security.js';

export const APP_ROLES = Object.freeze([
  'administrator',
  'forecaster',
  'chaser',
  'support',
  'viewer',
]);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function roles(value) {
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some((role) => !APP_ROLES.includes(role))
  )
    throw authError('invalid_roles', 400);
  return [...new Set(value)].sort();
}
export async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw authError('json_required', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw authError('body_too_large', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw authError('invalid_json', 400);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw authError('invalid_json', 400);
  return value;
}
async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4545)');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Explicit identity approvals also link identities; email equality never links users. */
export async function approveIdentity(
  client,
  { provider, subject, userId, displayName, grantedRoles },
  actor = null,
) {
  if (
    !['discord', 'google'].includes(provider) ||
    typeof subject !== 'string' ||
    !subject ||
    subject.length > 255 ||
    (provider === 'discord' && !/^[0-9]{1,20}$/.test(subject))
  )
    throw authError('invalid_identity', 400);
  const approvedRoles = roles(grantedRoles);
  const existing = (
    await client.query(
      'SELECT * FROM gev.external_identities WHERE provider=$1 AND subject=$2 FOR UPDATE',
      [provider, subject],
    )
  ).rows[0];
  if (userId && !uuid(userId)) throw authError('invalid_user', 400);
  if (existing && userId && existing.user_id !== userId) {
    const active =
      existing.approved ||
      existing.revoked_at ||
      (
        await client.query('SELECT FROM gev.sessions WHERE identity_id=$1', [
          existing.id,
        ])
      ).rowCount ||
      (
        await client.query('SELECT FROM gev.user_roles WHERE user_id=$1', [
          existing.user_id,
        ])
      ).rowCount;
    const linked = (
      await client.query(
        'SELECT FROM gev.external_identities WHERE user_id=$1 AND id<>$2',
        [existing.user_id, existing.id],
      )
    ).rowCount;
    if (active || linked) throw authError('identity_already_linked', 409);
    // Only a freshly verified, unapproved identity may be linked to an existing account.
    await client.query(
      'UPDATE gev.external_identities SET user_id=$2 WHERE id=$1',
      [existing.id, userId],
    );
    await client.query('UPDATE gev.users SET disabled_at=now() WHERE id=$1', [
      existing.user_id,
    ]);
    await audit(client, actor, 'identity.linked', 'identity', existing.id, {
      userId,
    });
  }
  let id = userId || existing?.user_id;
  if (!id)
    id = (
      await client.query(
        'INSERT INTO gev.users(display_name) VALUES ($1) RETURNING id',
        [String(displayName || 'Team member').slice(0, 80)],
      )
    ).rows[0].id;
  const user = (
    await client.query(
      'SELECT FROM gev.users WHERE id=$1 AND disabled_at IS NULL',
      [id],
    )
  ).rowCount;
  if (!user) throw authError('user_disabled', 403);
  await client.query(
    'INSERT INTO gev.external_identities(provider,subject,user_id,approved) VALUES ($1,$2,$3,true) ON CONFLICT(provider,subject) DO UPDATE SET approved=true,revoked_at=NULL',
    [provider, subject, id],
  );
  for (const role of approvedRoles)
    await client.query(
      'INSERT INTO gev.user_roles(user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, role],
    );
  await audit(client, actor, 'identity.approved', 'user', id, {
    provider,
    roles: approvedRoles,
  });
  return id;
}

/** Enforce workspace boundaries in addition to global permission checks. */
export async function authorizeWorkspace(
  pool,
  session,
  workspaceId,
  permission,
) {
  if (!uuid(workspaceId) || !session.permissions.includes(permission))
    return false;
  if (session.roles.includes('administrator'))
    return (
      (
        await pool.query('SELECT FROM gev.workspaces WHERE id=$1', [
          workspaceId,
        ])
      ).rowCount > 0
    );
  return (
    (
      await pool.query(
        `SELECT FROM gev.workspace_members m JOIN gev.role_permissions p ON p.role_id=m.role_id
    WHERE m.workspace_id=$1 AND m.user_id=$2 AND p.permission_id=$3`,
        [workspaceId, session.userId, permission],
      )
    ).rowCount > 0
  );
}

/** Sensitive changes and their audit rows commit together. */
export function administrationRoutes(pool, config) {
  return [
    {
      method: 'PATCH',
      path: '/api/profile',
      permissions: [],
      async handler({ req, session }) {
        const body = await readJson(req);
        if (
          typeof body.callsign !== 'string' ||
          body.callsign.length > 80 ||
          /[\u0000-\u001f\u007f]/.test(body.callsign)
        )
          throw authError('invalid_callsign', 400);
        await transaction(pool, async (client) => {
          await client.query('UPDATE gev.users SET callsign=$2 WHERE id=$1', [
            session.userId,
            body.callsign.trim() || null,
          ]);
          await audit(
            client,
            session.userId,
            'profile.changed',
            'user',
            session.userId,
          );
        });
        return { status: 200, body: { updated: true } };
      },
    },
    {
      method: 'GET',
      path: '/api/admin/users',
      permissions: ['identities:admin'],
      async handler() {
        const result = await pool.query(
          'SELECT id,display_name,callsign,disabled_at FROM gev.users ORDER BY created_at DESC LIMIT 200',
        );
        const identities = await pool.query(
          'SELECT id,provider,subject,user_id,approved,revoked_at FROM gev.external_identities ORDER BY created_at DESC LIMIT 200',
        );
        return {
          status: 200,
          body: { users: result.rows, identities: identities.rows },
        };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/identities',
      permissions: ['identities:admin', 'roles:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        const userId = await transaction(pool, (client) =>
          approveIdentity(
            client,
            { ...body, grantedRoles: body.roles },
            session.userId,
          ),
        );
        return { status: 200, body: { userId } };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/revoke-identity',
      permissions: ['identities:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        if (
          !['discord', 'google'].includes(body.provider) ||
          typeof body.subject !== 'string' ||
          body.subject.length > 255
        )
          throw authError('invalid_identity', 400);
        await transaction(pool, async (client) => {
          const identity = (
            await client.query(
              'UPDATE gev.external_identities SET approved=false,revoked_at=now() WHERE provider=$1 AND subject=$2 RETURNING id,user_id',
              [body.provider, body.subject],
            )
          ).rows[0];
          if (!identity) throw authError('identity_not_found', 404);
          if (identity.user_id === session.userId)
            throw authError('cannot_revoke_own_identity', 409);
          await client.query(
            'UPDATE gev.sessions SET revoked_at=now(),provider_tokens=NULL WHERE identity_id=$1',
            [identity.id],
          );
          await audit(
            client,
            session.userId,
            'identity.revoked',
            'identity',
            identity.id,
          );
        });
        return { status: 200, body: { revoked: true } };
      },
    },
    {
      method: 'PUT',
      path: '/api/admin/user-roles',
      permissions: ['roles:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        const next = roles(body.roles);
        if (!uuid(body.userId)) throw authError('invalid_user', 400);
        await transaction(pool, async (client) => {
          if (
            !(
              await client.query(
                'SELECT FROM gev.users WHERE id=$1 FOR UPDATE',
                [body.userId],
              )
            ).rowCount
          )
            throw authError('user_not_found', 404);
          if (
            !next.includes('administrator') &&
            (
              await client.query(
                `SELECT FROM gev.user_roles WHERE user_id=$1 AND role_id='administrator'`,
                [body.userId],
              )
            ).rowCount &&
            !(
              await client.query(
                `SELECT FROM gev.user_roles r JOIN gev.users u ON u.id=r.user_id WHERE role_id='administrator' AND user_id<>$1 AND u.disabled_at IS NULL`,
                [body.userId],
              )
            ).rowCount
          )
            throw authError('last_local_administrator', 409);
          await client.query('DELETE FROM gev.user_roles WHERE user_id=$1', [
            body.userId,
          ]);
          for (const role of next)
            await client.query(
              'INSERT INTO gev.user_roles(user_id,role_id) VALUES ($1,$2)',
              [body.userId, role],
            );
          await audit(
            client,
            session.userId,
            'roles.changed',
            'user',
            body.userId,
            { roles: next },
          );
        });
        return { status: 200, body: { updated: true } };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/disable-user',
      permissions: ['identities:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        if (!uuid(body.userId)) throw authError('invalid_user', 400);
        await transaction(pool, async (client) => {
          if (body.userId === session.userId)
            throw authError('cannot_disable_own_account', 409);
          if (
            (
              await client.query(
                "SELECT FROM gev.user_roles WHERE user_id=$1 AND role_id='administrator'",
                [body.userId],
              )
            ).rowCount &&
            !(
              await client.query(
                "SELECT FROM gev.user_roles r JOIN gev.users u ON u.id=r.user_id WHERE role_id='administrator' AND user_id<>$1 AND u.disabled_at IS NULL",
                [body.userId],
              )
            ).rowCount
          )
            throw authError('last_local_administrator', 409);
          if (
            !(
              await client.query(
                'UPDATE gev.users SET disabled_at=now() WHERE id=$1 RETURNING id',
                [body.userId],
              )
            ).rowCount
          )
            throw authError('user_not_found', 404);
          await client.query(
            'UPDATE gev.sessions SET revoked_at=now(),provider_tokens=NULL WHERE user_id=$1',
            [body.userId],
          );
          await audit(
            client,
            session.userId,
            'user.disabled',
            'user',
            body.userId,
          );
        });
        return { status: 200, body: { disabled: true } };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/revoke-sessions',
      permissions: ['identities:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        if (!uuid(body.userId)) throw authError('invalid_user', 400);
        await transaction(pool, async (client) => {
          await client.query(
            'UPDATE gev.sessions SET revoked_at=now(),provider_tokens=NULL WHERE user_id=$1',
            [body.userId],
          );
          await audit(
            client,
            session.userId,
            'sessions.revoked',
            'user',
            body.userId,
          );
        });
        return { status: 200, body: { revoked: true } };
      },
    },
    {
      method: 'PUT',
      path: '/api/admin/discord-role-mapping',
      permissions: ['roles:admin'],
      async handler({ req, session }) {
        const body = await readJson(req);
        const entries = Object.entries(body.mapping || {});
        if (
          !config.discord.guildId ||
          !body.mapping ||
          Array.isArray(body.mapping) ||
          typeof body.mapping !== 'object' ||
          entries.length > 100 ||
          entries.some(
            ([id, value]) => !/^[0-9]{1,20}$/.test(id) || !Array.isArray(value),
          )
        )
          throw authError('invalid_role_mapping', 400);
        const mapping = entries.map(([id, value]) => [id, roles(value)]);
        await transaction(pool, async (client) => {
          await client.query(
            'DELETE FROM gev.discord_role_mapping WHERE guild_id=$1',
            [config.discord.guildId],
          );
          for (const [id, assigned] of mapping)
            for (const role of assigned)
              await client.query(
                'INSERT INTO gev.discord_role_mapping(guild_id,discord_role_id,role_id) VALUES ($1,$2,$3)',
                [config.discord.guildId, id, role],
              );
          await audit(
            client,
            session.userId,
            'discord.mapping.changed',
            'guild',
            config.discord.guildId,
            { mapping: Object.fromEntries(mapping) },
          );
        });
        return { status: 200, body: { updated: true } };
      },
    },
    {
      method: 'GET',
      path: '/api/admin/audit',
      permissions: ['audit:read'],
      async handler() {
        return {
          status: 200,
          body: {
            events: (
              await pool.query(
                'SELECT actor_id,action,resource_type,resource_id,metadata,occurred_at FROM gev.audit_log ORDER BY id DESC LIMIT 100',
              )
            ).rows,
          },
        };
      },
    },
  ];
}
