import { parseArgs } from 'node:util';
import { createDatabasePool } from '../server/database/connection.js';
import {
  approveIdentity,
  APP_ROLES,
} from '../backend/identity/administration.js';
import { audit } from '../backend/identity/service.js';

// This operator command uses the migration identity; it is never an HTTP route.
const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    subject: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    'user-id': { type: 'string' },
    guild: { type: 'string' },
    'discord-role': { type: 'string' },
  },
});
const assigned = (values.role || '').split(',').filter(Boolean);
if (!assigned.length || assigned.some((role) => !APP_ROLES.includes(role)))
  throw new Error('Supply known GEV roles with --role');
const pool = createDatabasePool({ migrate: true });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE gev_owner');
  await client.query('SELECT pg_advisory_xact_lock(4545)');
  if (values.guild || values['discord-role']) {
    if (
      !/^[0-9]{1,20}$/.test(values.guild || '') ||
      !/^[0-9]{1,20}$/.test(values['discord-role'] || '')
    )
      throw new Error('Supply stable guild and Discord role IDs');
    for (const role of assigned)
      await client.query(
        'INSERT INTO gev.discord_role_mapping(guild_id,discord_role_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [values.guild, values['discord-role'], role],
      );
    await audit(
      client,
      null,
      'discord.mapping.changed',
      'guild',
      values.guild,
      {
        source: 'operator',
        discordRole: values['discord-role'],
        roles: assigned,
      },
    );
    console.log('Discord role mapping configured.');
  } else {
    const userId = await approveIdentity(client, {
      provider: values.provider,
      subject: values.subject,
      displayName: values.name,
      userId: values['user-id'],
      grantedRoles: assigned,
    });
    console.log(`Approved GEV user ${userId}.`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release(true);
  await pool.end();
}
