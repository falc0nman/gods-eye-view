import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from '../server/database/connection.js';
import { migrate } from '../server/database/migrate.js';

const workspaceId = '85858585-8585-4585-8585-858585858584';
const targetId = '85858585-8585-4585-8585-858585858585';
const app = createDatabasePool();
const owner = createDatabasePool({ migrate: true });
async function cleanup() {
  await app.query('DELETE FROM gev.workspaces WHERE id = $1', [workspaceId]);
}

try {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
  } else if (process.argv.includes('--persisted')) {
    const result = await app.query(
      'SELECT label FROM gev.targets WHERE id = $1',
      [targetId],
    );
    assert.equal(result.rows[0]?.label, 'GW-85 restore fixture');
    console.log('PASS: target persisted across database restart');
  } else {
    assert.equal(
      process.getuid(),
      1000,
      'container command must run as the node user',
    );
    // Idempotence and advisory-lock serialization must hold with real connections.
    await Promise.all([migrate(owner), migrate(owner)]);
    assert.equal(
      (await app.query('SELECT count(*)::int AS n FROM gev.schema_migrations'))
        .rows[0].n,
      (
        await readdir(new URL('../database/migrations/', import.meta.url))
      ).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).length,
    );
    const roles = await app.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    assert.deepEqual(roles.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    for (const sql of [
      'CREATE TABLE gev.qa_forbidden(id int)',
      'SET ROLE gev_owner',
      'DELETE FROM gev.schema_migrations',
      'DELETE FROM gev.audit_log',
      'UPDATE gev.retention_policy SET position_days = 1',
      'SELECT gev.prune_history()',
    ])
      await assert.rejects(app.query(sql), (error) => error.code === '42501');
    console.log(
      'PASS: migrations serialize and runtime cannot administer the database',
    );

    const directory = await mkdtemp(join(tmpdir(), 'gev-migrations-'));
    try {
      const url = pathToFileURL(`${directory}/`);
      await assert.rejects(migrate(owner, url), /Applied migration is missing/);
      // Every real migration after the first, unchanged.
      const migrations = (
        await readdir(new URL('../database/migrations/', import.meta.url))
      )
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
      for (const name of migrations.slice(1))
        await writeFile(
          join(directory, name),
          await readFile(
            new URL(`../database/migrations/${name}`, import.meta.url),
          ),
        );
      await writeFile(join(directory, '0001_initial.sql'), 'SELECT 1;');
      await assert.rejects(
        migrate(owner, url),
        /Applied migration was modified/,
      );
      await writeFile(
        join(directory, '0001_initial.sql'),
        await readFile(
          new URL('../database/migrations/0001_initial.sql', import.meta.url),
        ),
      );
      await writeFile(
        join(directory, '9999_rollback_probe.sql'),
        'CREATE TABLE gev.qa_atomic_rollback(id integer); SELECT gev.qa_missing_function();',
      );
      await assert.rejects(
        migrate(owner, url),
        (error) => error.code === '42883',
      );
      assert.equal(
        (
          await app.query(
            "SELECT to_regclass('gev.qa_atomic_rollback') AS name",
          )
        ).rows[0].name,
        null,
      );
      assert.equal(
        (
          await app.query(
            'SELECT count(*)::int AS n FROM gev.schema_migrations',
          )
        ).rows[0].n,
        migrations.length,
      );
      console.log(
        'PASS: failed migration rolls back both schema changes and ledger',
      );
      console.log('PASS: migration deletion and checksum drift are rejected');
    } finally {
      await rm(directory, { recursive: true });
    }

    await cleanup();
    await app.query('INSERT INTO gev.workspaces(id, name) VALUES ($1, $2)', [
      workspaceId,
      'GW-85 integration test',
    ]);
    const listener = await app.connect();
    try {
      await listener.query('LISTEN gev_workspace_changes');
      const notification = once(listener, 'notification', {
        signal: AbortSignal.timeout(10000),
      });
      await app.query(
        `INSERT INTO gev.targets(id, workspace_id, label, location)
        VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint(-97.7, 30.3), 4326))`,
        [targetId, workspaceId, 'GW-85 restore fixture'],
      );
      const [event] = await notification;
      assert.deepEqual(JSON.parse(event.payload), {
        table: 'targets',
        operation: 'INSERT',
        workspace_id: workspaceId,
      });
      const spatial = await app.query(
        `SELECT id FROM gev.targets WHERE workspace_id = $1
        AND ST_Intersects(location, ST_MakeEnvelope(-98, 30, -97, 31, 4326))`,
        [workspaceId],
      );
      assert.equal(spatial.rows[0].id, targetId);
      const indexes = await app.query(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'gev' AND indexdef LIKE '%USING gist%'",
      );
      assert.equal(indexes.rows[0].n, 4);
      console.log(
        'PASS: spatial queries, GiST indexes, and committed workspace notifications',
      );
    } finally {
      listener.release(true);
    }

    // Test retention inside a transaction, so existing operator history is preserved.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE gev_owner');
      const userId = (
        await client.query(
          "INSERT INTO gev.users(display_name) VALUES ('retention test') RETURNING id",
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO gev.team_positions(workspace_id, user_id, location, observed_at, source)
        VALUES ($1, $2, ST_SetSRID(ST_MakePoint(-97, 30), 4326), now() - interval '4000 days', 'qa'),
          ($1, $2, ST_SetSRID(ST_MakePoint(-97, 30), 4326), now(), 'qa')`,
        [workspaceId, userId],
      );
      const feedId = (
        await client.query(
          "INSERT INTO gev.feeds(name, kind, provider) VALUES ('qa', 'position', 'qa') RETURNING id",
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO gev.feed_health(feed_id, status, observed_at)
        VALUES ($1, 'healthy', now() - interval '4000 days'), ($1, 'healthy', now())`,
        [feedId],
      );
      await client.query('SELECT gev.prune_history()');
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM gev.team_positions WHERE user_id = $1',
            [userId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM gev.feed_health WHERE feed_id = $1',
            [feedId],
          )
        ).rows[0].n,
        1,
      );
      await client.query('ROLLBACK');
      console.log(
        'PASS: history retention removes expired rows and preserves recent rows',
      );
    } finally {
      client.release(true);
    }
    console.log(
      'Database integration checks passed; fixture ready for restart and restore verification.',
    );
  }
} finally {
  await Promise.all([app.end(), owner.end()]);
}
