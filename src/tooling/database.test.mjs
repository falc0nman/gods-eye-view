import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  secret,
  createDatabasePool,
} from '../../server/database/connection.js';
import { databasePlugin } from '../../server/providers/database.js';

test('server credentials prefer mounted files and missing credentials fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gev-secrets-'));
  try {
    const file = join(directory, 'password');
    writeFileSync(file, 'file-fixture\n');
    assert.equal(
      secret('PASSWORD', { PASSWORD_FILE: file, PASSWORD: 'env-fixture' }),
      'file-fixture',
    );
    assert.equal(
      secret('PASSWORD', { PASSWORD: 'env-fixture' }),
      'env-fixture',
    );
    assert.throws(() => secret('PASSWORD', {}), /Missing server credential/);
    writeFileSync(file, '\n');
    assert.throws(
      () =>
        secret('PASSWORD', { PASSWORD_FILE: file, PASSWORD: 'env-fixture' }),
      /Missing server credential/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('runtime and migration connections use distinct bounded, non-admin identities', async () => {
  const env = {
    GEV_DB_PASSWORD: 'app-fixture',
    GEV_DB_MIGRATOR_PASSWORD: 'migration-fixture',
    GEV_DB_SSL: 'require',
  };
  const app = createDatabasePool({ env });
  const migration = createDatabasePool({ env, migrate: true });
  try {
    assert.equal(app.options.user, 'gev_app');
    assert.equal(migration.options.user, 'gev_migrator');
    assert.equal(app.options.max, 10);
    assert.equal(app.options.statement_timeout, 10000);
    assert.equal(app.options.connectionTimeoutMillis, 5000);
    assert.deepEqual(app.options.ssl, { rejectUnauthorized: true });
    assert.equal(migration.options.password, 'migration-fixture');
  } finally {
    await Promise.all([app.end(), migration.end()]);
  }
});

test('health works in dev and preview, redacts errors, and closes its pool', async () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let handler;
    let failed = false;
    let closed = false;
    const pool = new EventEmitter();
    pool.query = async () => {
      if (failed) throw new Error('secret-fixture');
    };
    pool.end = async () => {
      closed = true;
    };
    const server = {
      httpServer: new EventEmitter(),
      middlewares: {
        use: (_, value) => {
          handler = value;
        },
      },
    };
    databasePlugin({ env: { GEV_DB_HOST: 'db' }, createPool: () => pool })[
      hook
    ](server);
    async function request(method = 'GET') {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) {
          this.headers[key] = value;
        },
        end(body) {
          this.body = JSON.parse(body);
        },
      };
      await handler({ method, url: '/' }, res);
      return res;
    }
    assert.deepEqual((await request()).body, { status: 'ready' });
    failed = true;
    const response = await request();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { status: 'unavailable' });
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal((await request('POST')).statusCode, 405);
    server.httpServer.emit('close');
    assert.equal(closed, true);
  }
});

test('optional database health reports disabled without creating a pool', async () => {
  let handler;
  databasePlugin({
    env: {},
    createPool: () => {
      throw new Error('must remain disabled');
    },
  }).configureServer({
    middlewares: {
      use: (_, value) => {
        handler = value;
      },
    },
  });
  const res = {
    setHeader() {},
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await handler({ method: 'GET', url: '/' }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { status: 'disabled' });
});
