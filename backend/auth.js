import { createHash } from 'node:crypto';

export const DEFAULT_SESSION_COOKIE = '__Host-gev_session';

/** Accept one opaque cookie only; never trust identity or role headers. */
export function sessionToken(cookie, name = DEFAULT_SESSION_COOKIE) {
  if (typeof cookie !== 'string' || cookie.length > 8192) return null;
  const values = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf('=')) === name)
    .map((part) => part.slice(part.indexOf('=') + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43,128}$/.test(values[0])
    ? values[0]
    : null;
}

/** Resolve live session, user status and permissions on every API request. */
export async function authenticate(
  req,
  pool,
  cookieName = DEFAULT_SESSION_COOKIE,
) {
  const token = sessionToken(req.headers.cookie, cookieName);
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  const { rows } = await pool.query(
    `
    SELECT s.user_id, s.expires_at, u.display_name,
      COALESCE(array_agg(DISTINCT ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), ARRAY[]::text[]) AS roles,
      COALESCE(array_agg(DISTINCT rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), ARRAY[]::text[]) AS permissions
    FROM gev.sessions s
    JOIN gev.users u ON u.id = s.user_id
    LEFT JOIN gev.user_roles ur ON ur.user_id = u.id
    LEFT JOIN gev.role_permissions rp ON rp.role_id = ur.role_id
    WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
    GROUP BY s.user_id, s.expires_at, u.display_name`,
    [hash],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    userId: row.user_id,
    displayName: row.display_name,
    expiresAt: row.expires_at,
    roles: row.roles,
    permissions: row.permissions,
  };
}

/** Cookie-authenticated writes require a configured origin and custom header. */
export function sameOriginWrite(req, publicOrigin) {
  return (
    Boolean(publicOrigin) &&
    req.headers.origin === publicOrigin &&
    req.headers['x-gev-csrf'] === '1' &&
    !['cross-site', 'none'].includes(req.headers['sec-fetch-site'])
  );
}

/** Session issuance belongs to GW-45; keep its cookie policy centralized. */
export function sessionCookie(
  token,
  { name = DEFAULT_SESSION_COOKIE, secure = true, maxAge = 28800 } = {},
) {
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
    !/^[A-Za-z0-9_-]+$/.test(name) ||
    !Number.isInteger(maxAge) ||
    maxAge < 0 ||
    maxAge > 604800 ||
    (name.startsWith('__Host-') && !secure)
  )
    throw new Error('Invalid session cookie policy');
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
