/**
 * Test harness: call provider routes the way the backend does, through
 * `registry.apiRoutes()` (exact path match, handler({req, session})).
 * Responses come back shaped like a Node response: status, headers, and a
 * body that is the PNG bytes or the JSON text.
 */
export function routeCaller(registry, { prefix = '', session = null } = {}) {
  const routes = new Map(registry.apiRoutes().map((r) => [r.path, r]));
  return async (url) => {
    const full = `${prefix}${url}`;
    const path = new URL(full, 'http://local').pathname;
    const route = routes.get(path);
    if (!route)
      return {
        status: 404,
        headers: {},
        body: JSON.stringify({ error: 'not_found' }),
      };
    const result = await route.handler({
      req: { url: full, method: 'GET', headers: {} },
      session,
    });
    return {
      status: result.status,
      permissions: route.permissions,
      headers: {
        'Content-Type': result.bytes ? result.contentType : 'application/json',
        'Cache-Control': result.cacheControl ?? 'no-store',
        ...(result.headers ?? {}),
      },
      body: result.bytes ?? JSON.stringify(result.body ?? {}),
    };
  };
}
