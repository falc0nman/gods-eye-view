import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDatabasePool } from '../server/database/connection.js';

const bases = [
  process.env.GEV_TEST_BASE_URL || 'http://localhost:4173',
  process.env.GEV_TEST_BACKEND_URL || 'http://localhost:3000',
];
async function request(base, path, headers = {}) {
  return fetch(`${base}${path}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
}
if (process.argv.includes('--outage')) {
  for (const base of bases) {
    assert.equal((await request(base, '/healthz')).status, 200);
    const result = await request(base, '/readyz');
    assert.equal(result.status, 503);
    const body = await result.text();
    assert.equal(/password|postgres|db:5432|ECONNREFUSED/.test(body), false);
    const cookie = `${process.env.GEV_SESSION_COOKIE || 'gev_session'}=${randomBytes(32).toString('base64url')}`;
    assert.equal(
      (await request(base, '/api/session', { Cookie: cookie })).status,
      503,
    );
  }
  console.log(
    'PASS: liveness survives database outage, readiness fails and authenticated API fails closed',
  );
} else {
  const pool = createDatabasePool();
  const roleId = `qa-gw86-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const headers = {
    Cookie: `${process.env.GEV_SESSION_COOKIE || 'gev_session'}=${token}`,
  };
  let userId;
  let createdPermission = false;
  try {
    const identity = (await pool.query('SELECT current_user AS identity'))
      .rows[0].identity;
    assert.equal(identity, 'gev_app');
    userId = (
      await pool.query(
        "INSERT INTO gev.users(display_name) VALUES ('GW-86 QA') RETURNING id",
      )
    ).rows[0].id;
    await pool.query('INSERT INTO gev.roles(id, description) VALUES ($1, $2)', [
      roleId,
      'GW-86 QA fixture',
    ]);
    await pool.query(
      'INSERT INTO gev.user_roles(user_id, role_id) VALUES ($1, $2)',
      [userId, roleId],
    );
    const identityId = (
      await pool.query(
        "INSERT INTO gev.external_identities(provider,subject,user_id,approved) VALUES ('google',$1,$2,true) RETURNING id",
        [randomUUID(), userId],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO gev.sessions(token_hash,user_id,identity_id,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
      [hash, userId, identityId],
    );
    for (const base of bases) {
      assert.equal((await request(base, '/api/session')).status, 401);
      assert.equal(
        (
          await request(base, '/api/session', {
            'X-User-Id': userId,
            'X-Role': 'administrator',
          })
        ).status,
        401,
      );
      const response = await request(base, '/api/session', headers);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.userId, userId);
      assert.deepEqual(body.roles, [roleId]);
      assert.equal(JSON.stringify(body).includes(token), false);
      assert.equal(
        (await request(base, '/api/database/health', headers)).status,
        403,
      );
      assert.equal(
        (await request(base, '/api/not-registered', headers)).status,
        403,
      );
    }
    console.log(
      'PASS: real hashed sessions, current user roles and anonymous/default API denial through both services',
    );

    createdPermission =
      (
        await pool.query(
          "INSERT INTO gev.permissions(id, description) VALUES ('system:read', 'Read service status') ON CONFLICT DO NOTHING RETURNING id",
        )
      ).rowCount > 0;
    await pool.query(
      "INSERT INTO gev.role_permissions(role_id, permission_id) VALUES ($1, 'system:read')",
      [roleId],
    );
    for (const base of bases)
      assert.equal(
        (await request(base, '/api/database/health', headers)).status,
        200,
      );
    await pool.query('DELETE FROM gev.role_permissions WHERE role_id = $1', [
      roleId,
    ]);
    for (const base of bases)
      assert.equal(
        (await request(base, '/api/database/health', headers)).status,
        403,
      );
    console.log(
      'PASS: granting and revoking permissions takes effect on the next request',
    );

    await pool.query(
      'UPDATE gev.sessions SET revoked_at = now() WHERE token_hash = $1',
      [hash],
    );
    for (const base of bases)
      assert.equal((await request(base, '/api/session', headers)).status, 401);
    await pool.query(
      "UPDATE gev.sessions SET revoked_at = NULL, created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE token_hash = $1",
      [hash],
    );
    for (const base of bases)
      assert.equal((await request(base, '/api/session', headers)).status, 401);
    await pool.query(
      "UPDATE gev.sessions SET created_at = now(), expires_at = now() + interval '1 hour' WHERE token_hash = $1",
      [hash],
    );
    await pool.query('UPDATE gev.users SET disabled_at = now() WHERE id = $1', [
      userId,
    ]);
    for (const base of bases)
      assert.equal((await request(base, '/api/session', headers)).status, 401);
    console.log(
      'PASS: revoked and expired sessions and disabled users lose access immediately',
    );
  } finally {
    try {
      if (userId)
        await pool.query('DELETE FROM gev.users WHERE id = $1', [userId]);
      await pool.query('DELETE FROM gev.roles WHERE id = $1', [roleId]);
      if (createdPermission)
        await pool.query(
          "DELETE FROM gev.permissions WHERE id = 'system:read' AND NOT EXISTS (SELECT FROM gev.role_permissions WHERE permission_id = 'system:read')",
        );
    } finally {
      await pool.end();
    }
  }
}
