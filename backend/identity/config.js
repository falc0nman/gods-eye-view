import { secret } from '../../server/database/connection.js';

/** Require HTTPS except explicit loopback development and load only server secrets. */
export function identityConfig(env = process.env) {
  const origin = env.GEV_PUBLIC_ORIGIN || 'http://localhost:4173';
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new Error('Authentication requires HTTPS or loopback HTTP');
  const secure = url.protocol === 'https:';
  const read = (name) =>
    env[name] || env[`${name}_FILE`] ? secret(name, env) : undefined;
  const raw = read('GEV_AUTH_KEY');
  if (raw && !/^[a-f0-9]{64}$/.test(raw))
    throw new Error('GEV_AUTH_KEY must contain 32 hex-encoded random bytes');
  const cookieName =
    env.GEV_SESSION_COOKIE || (secure ? '__Host-gev_session' : 'gev_session');
  if (secure && cookieName !== '__Host-gev_session')
    throw new Error(
      'HTTPS authentication requires the host-prefixed session cookie',
    );
  if (
    !/^[A-Za-z0-9_-]+$/.test(cookieName) ||
    (!secure && cookieName.startsWith('__Host-'))
  )
    throw new Error('Invalid session cookie configuration');
  const discord = {
    clientId: env.GEV_DISCORD_CLIENT_ID,
    clientSecret: read('GEV_DISCORD_CLIENT_SECRET'),
    botToken: read('GEV_DISCORD_BOT_TOKEN'),
    guildId: env.GEV_DISCORD_GUILD_ID,
  };
  if (discord.guildId && !/^[0-9]{1,20}$/.test(discord.guildId))
    throw new Error('Invalid Discord guild ID');
  const google = {
    clientId: env.GEV_GOOGLE_CLIENT_ID,
    clientSecret: read('GEV_GOOGLE_CLIENT_SECRET'),
  };
  return {
    origin,
    secure,
    cookieName,
    flowCookie: secure ? '__Host-gev_oauth' : 'gev_oauth',
    key: raw ? Buffer.from(raw, 'hex') : null,
    discord: {
      ...discord,
      enabled: Boolean(
        raw &&
        discord.clientId &&
        discord.clientSecret &&
        discord.botToken &&
        discord.guildId,
      ),
    },
    google: {
      ...google,
      enabled: Boolean(raw && google.clientId && google.clientSecret),
    },
  };
}
