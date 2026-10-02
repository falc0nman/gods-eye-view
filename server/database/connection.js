import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Read a server secret from the environment or a mounted secret file. */
export function secret(name, env = process.env) {
  const value = env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`], 'utf8').trim()
    : env[name];
  if (!value) throw new Error(`Missing server credential: ${name}`);
  return value;
}

/** Create a bounded server-only pool using the runtime or migration identity. */
export function createDatabasePool({
  env = process.env,
  migrate = false,
} = {}) {
  return new pg.Pool({
    host: env.GEV_DB_HOST || 'localhost',
    port: Number(env.GEV_DB_PORT || 5432),
    database: env.GEV_DB_NAME || 'gev',
    user: migrate ? 'gev_migrator' : 'gev_app',
    password: secret(
      migrate ? 'GEV_DB_MIGRATOR_PASSWORD' : 'GEV_DB_PASSWORD',
      env,
    ),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: migrate ? 0 : 10000,
    application_name: migrate ? 'gev-migrations' : 'gev',
    ssl: env.GEV_DB_SSL === 'require' ? { rejectUnauthorized: true } : false,
  });
}
