import { createRemoteJWKSet, jwtVerify } from 'jose';
import { authError, equal } from './security.js';

const googleKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
  { timeoutDuration: 5000 },
);

/** Fixed HTTPS endpoints, bounded responses and no redirected credential requests. */
export function identityProviders(
  config,
  { fetchImpl = fetch, keys = googleKeys } = {},
) {
  async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok)
      throw authError(
        [400, 401, 403, 404].includes(response.status)
          ? 'provider_access_revoked'
          : 'identity_provider_unavailable',
        [400, 401, 403, 404].includes(response.status) ? 401 : 503,
      );
    if (!response.body) return {};
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw authError('invalid_provider_response', 503);
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    return size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }
  function token(provider, values) {
    const settings = config[provider];
    const body = new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      ...values,
    });
    return request(
      provider === 'discord'
        ? 'https://discord.com/api/oauth2/token'
        : 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
  }
  async function member(subject) {
    if (!/^[0-9]{1,20}$/.test(subject)) throw authError('invalid_identity');
    const data = await request(
      `https://discord.com/api/v10/guilds/${config.discord.guildId}/members/${subject}`,
      { headers: { Authorization: `Bot ${config.discord.botToken}` } },
    );
    if (
      data.user?.id !== subject ||
      !Array.isArray(data.roles) ||
      data.pending === true ||
      data.roles.some(
        (id) => typeof id !== 'string' || !/^[0-9]{1,20}$/.test(id),
      )
    )
      throw authError('guild_membership_required', 403);
    return data.roles;
  }
  return {
    authorization(provider, { state, nonce, challenge, redirectUri }) {
      const url = new URL(
        provider === 'discord'
          ? 'https://discord.com/oauth2/authorize'
          : 'https://accounts.google.com/o/oauth2/v2/auth',
      );
      const values = {
        client_id: config[provider].clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        scope: provider === 'discord' ? 'identify' : 'openid email profile',
      };
      // Discord's confidential-client code flow uses its client secret; Google also supports PKCE.
      if (provider === 'google')
        Object.assign(values, {
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
      url.search = new URLSearchParams(values).toString();
      return url.href;
    },
    async exchange(provider, code, flow) {
      const data = await token(provider, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        ...(provider === 'google' ? { code_verifier: flow.verifier } : {}),
      });
      if (provider === 'google') {
        const { payload } = await jwtVerify(data.id_token, keys, {
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
          audience: config.google.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
          maxTokenAge: '10m',
        });
        if (
          !equal(payload.nonce, flow.nonce) ||
          typeof payload.sub !== 'string' ||
          !payload.sub ||
          payload.email_verified !== true ||
          (payload.azp && payload.azp !== config.google.clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp)
        )
          throw authError('invalid_identity');
        return {
          subject: payload.sub,
          displayName: String(
            payload.name || payload.email || 'Team member',
          ).slice(0, 80),
        };
      }
      if (
        data.token_type?.toLowerCase() !== 'bearer' ||
        !data.access_token ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        throw authError('invalid_provider_response', 503);
      const profile = await request('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      const roles = await member(profile.id);
      return {
        subject: profile.id,
        displayName: String(
          profile.global_name || profile.username || 'Team member',
        ).slice(0, 80),
        roles,
        tokens: {
          access: data.access_token,
          refresh: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        },
      };
    },
    async revalidate(subject, tokens) {
      if (tokens.expiresAt <= Date.now() + 30000) {
        if (!tokens.refresh) throw authError('provider_access_revoked');
        const data = await token('discord', {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh,
        });
        if (
          !data.access_token ||
          data.token_type?.toLowerCase() !== 'bearer' ||
          !Number.isFinite(data.expires_in) ||
          !(data.expires_in > 0)
        )
          throw authError('provider_access_revoked');
        tokens = {
          access: data.access_token,
          refresh: data.refresh_token || tokens.refresh,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
      }
      const profile = await request('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokens.access}` },
      });
      if (profile.id !== subject) throw authError('invalid_identity');
      return { roles: await member(subject), tokens };
    },
    async revoke(tokens) {
      if (tokens?.access)
        await request('https://discord.com/api/oauth2/token/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.discord.clientId,
            client_secret: config.discord.clientSecret,
            token: tokens.access,
          }),
        });
    },
  };
}
