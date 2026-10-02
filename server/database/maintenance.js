import { setTimeout } from 'node:timers/promises';
import { createDatabasePool } from './connection.js';

const pool = createDatabasePool({ migrate: true });
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => controller.abort());
}
try {
  while (!controller.signal.aborted) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE gev_owner');
      await client.query('SELECT gev.prune_history()');
      await client.query('COMMIT');
      console.log('[database] History retention applied');
    } finally {
      client.release(true);
    }
    await setTimeout(3600000, undefined, { signal: controller.signal });
  }
} catch (error) {
  if (error.name !== 'AbortError') throw error;
} finally {
  await pool.end();
}
