export const readinessSql = `SELECT PostGIS_Version(), EXISTS (
  SELECT FROM gev.schema_migrations WHERE name = '0001_initial.sql'
) AS migrated`;

export async function databaseReady(pool) {
  const result = await pool.query(readinessSql);
  return result.rows[0]?.migrated === true;
}

/** Every API declaration must state its permission policy. [] still requires a session. */
export function coreRoutes(pool) {
  return [
    {
      method: 'GET',
      path: '/api/session',
      permissions: [],
      async handler({ session }) {
        return { status: 200, body: session };
      },
    },
    {
      method: 'GET',
      path: '/api/database/health',
      permissions: ['system:read'],
      async handler() {
        const ready = await databaseReady(pool);
        return {
          status: ready ? 200 : 503,
          body: { status: ready ? 'ready' : 'unavailable' },
        };
      },
    },
  ];
}
