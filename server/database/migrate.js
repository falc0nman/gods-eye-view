import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabasePool } from './connection.js';

const directory = new URL('../../database/migrations/', import.meta.url);

/** Apply immutable, checksummed SQL migrations under a database-wide lock. */
export async function migrate(pool, migrationDirectory = directory) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(8585)');
    await client.query('SET ROLE gev_owner');
    await client.query(`CREATE TABLE IF NOT EXISTS gev.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const applied = new Map(
      (
        await client.query('SELECT name, checksum FROM gev.schema_migrations')
      ).rows.map((row) => [row.name, row.checksum]),
    );
    for (const name of applied.keys()) {
      if (!files.includes(name))
        throw new Error(`Applied migration is missing: ${name}`);
    }
    for (const name of files) {
      const sql = await readFile(
        new URL(name, pathToFileURL(`${fileURLToPath(migrationDirectory)}/`)),
        'utf8',
      );
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum)
          throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO gev.schema_migrations(name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    // Destroy the migration connection, releasing both role and session lock.
    client.release(true);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pool = createDatabasePool({ migrate: true });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
