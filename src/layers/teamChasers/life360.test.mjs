import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChaserPlacefile,
  chaserPositions,
  chaserRoster,
  colorForAge,
  createLife360Client,
  formatFixAge,
  normalizeSelection,
  parseAllowlist,
} from '../../../server/providers/life360/core.js';

const NOW = Date.parse('2026-10-02T01:00:00Z');
const sec = (ms) => String(Math.floor(ms / 1000));

const MEMBERS = [
  { id: 'm1', firstName: 'Dana', lastName: 'Private', location: { latitude: '35.2', longitude: '-97.4', timestamp: sec(NOW - 30_000), battery: '81', name: 'Moore "south"' } },
  { id: 'm2', firstName: 'Sam', location: { latitude: '36.1', longitude: '-98.0', timestamp: sec(NOW - 300_000) } },
  { id: 'm3', firstName: 'Kit', location: {} },
];

test('allowlist is case-insensitive first names; empty shows everyone', () => {
  assert.deepEqual([...parseAllowlist(' RJ, dana ,,Sam')], ['rj', 'dana', 'sam']);
  assert.equal(parseAllowlist(undefined).size, 0);
});

test('fix age colors and labels match the Python bridge', () => {
  assert.deepEqual(colorForAge(120), [0, 220, 0]);
  assert.deepEqual(colorForAge(600), [255, 190, 0]);
  assert.deepEqual(colorForAge(601), [200, 60, 60]);
  assert.equal(formatFixAge(30), '30s ago');
  assert.equal(formatFixAge(300), '5m ago');
  assert.equal(formatFixAge(null), 'unknown');
});

test('positions skip members without a fix and honor the allowlist', () => {
  const all = chaserPositions(MEMBERS, { nowMs: NOW });
  assert.deepEqual(all.map((p) => p.name), ['Dana', 'Sam']);
  assert.equal(all[0].ageS, 30);
  assert.equal(all[0].battery, 81);
  const onlySam = chaserPositions(MEMBERS, { nowMs: NOW, allowlist: parseAllowlist('sam') });
  assert.deepEqual(onlySam.map((p) => p.name), ['Sam']);
});

test('placefile matches the Python bridge format, health banner included', () => {
  const body = buildChaserPlacefile(chaserPositions(MEMBERS.slice(0, 1), { nowMs: NOW }), {
    health: { state: 'OK', detail: '3 chasers' }, lat: 35, lon: -97, nowMs: NOW,
  });
  assert.equal(body, [
    '; Life360 chaser positions -> Supercell Wx',
    'Title: Chasers (Life360)',
    'RefreshSeconds: 15',
    'Font: 1, 12, 1, "Arial"',
    'Threshold: 999',
    '',
    'Object: 35.000000,-97.000000\nThreshold: 999\nColor: 0 220 0\nText: 0,150,1,"L360 OK  01:00:00Z  -  3 chasers"\nEnd:\n',
    'Object: 35.200000,-97.400000\nThreshold: 999\nColor: 0 220 0\nTriangles:\n 0,9\n 9,0\n 0,-9\n 0,9\n 0,-9\n -9,0\nEnd:\n'
      + 'Color: 255 255 255\nText: 11,0,1,"Dana","Dana | fix 30s ago | batt 81% | Moore \'south\'"\nEnd:\n',
  ].join('\n') + '\n');
  assert.ok(!body.includes('Private'), 'last names never appear');
});

function fakeLife360({ fail = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.life360.com/v3', '');
    calls.push(path);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    if (fail.has(path)) return { ok: false, status: 429, json: async () => ({}) };
    if (path === '/circles') return { ok: true, status: 200, json: async () => ({ circles: [{ id: 'c1' }, { id: 'c2' }] }) };
    return { ok: true, status: 200, json: async () => ({ members: path.includes('c1') ? MEMBERS : [] }) };
  };
  return { calls, fetchImpl };
}

test('members are throttled to one upstream pull per 12 s and circles cached for 10 min', async () => {
  let clock = NOW;
  const { calls, fetchImpl } = fakeLife360();
  const client = createLife360Client({ token: 'tok', fetchImpl, now: () => clock });
  assert.equal(client.health().state, 'INIT');
  await Promise.all([client.getMembers(), client.getMembers()]);
  assert.deepEqual(calls, ['/circles', '/circles/c1/members', '/circles/c2/members'], 'concurrent callers share one pull');
  clock += 5_000;
  await client.getMembers();
  assert.equal(calls.length, 3, 'within 12 s serves the cache');
  clock += 10_000;
  await client.getMembers();
  assert.deepEqual(calls.slice(3), ['/circles/c1/members', '/circles/c2/members'], 'circle ids came from cache');
  assert.deepEqual(client.health(), { state: 'OK', detail: '3 chasers' });
});

test('throttling keeps the last snapshot and walks health to STALE then FAIL', async () => {
  let clock = NOW;
  const fail = new Set();
  const { fetchImpl } = fakeLife360({ fail });
  const client = createLife360Client({ token: 'tok', fetchImpl, now: () => clock });
  await client.getMembers();
  fail.add('/circles/c1/members').add('/circles/c2/members');
  clock += 30_000;
  assert.equal((await client.getMembers()).length, 3, 'stale beats empty');
  assert.equal(client.health().state, 'OK');
  clock += 40_000;
  await client.getMembers();
  assert.equal(client.health().state, 'FAIL');
  assert.match(client.health().detail, /throttled 429/);
});

test('circle filter restricts which circles are pulled', async () => {
  const { calls, fetchImpl } = fakeLife360();
  const client = createLife360Client({ token: 'tok', circleFilter: 'c2', fetchImpl, now: () => NOW });
  await client.getMembers();
  assert.deepEqual(calls, ['/circles', '/circles/c2/members']);
});

// ── Picker selection ────────────────────────────────────────────────────────

test('a saved picker selection wins over CHASER_ALLOWLIST; empty ids means everyone', () => {
  const allowlist = parseAllowlist('dana');
  assert.deepEqual(chaserPositions(MEMBERS, { nowMs: NOW, allowlist }).map((p) => p.name), ['Dana']);
  assert.deepEqual(chaserPositions(MEMBERS, { nowMs: NOW, allowlist, selection: { ids: ['m2'] } }).map((p) => p.name), ['Sam']);
  assert.deepEqual(chaserPositions(MEMBERS, { nowMs: NOW, allowlist, selection: { ids: [] } }).map((p) => p.name), ['Dana', 'Sam']);
});

test('roster lists everyone with first name + last initial, fix state and who shows', () => {
  const { mode, roster } = chaserRoster(MEMBERS, { selection: { ids: ['m1'] } });
  assert.equal(mode, 'picker');
  assert.deepEqual(roster, [
    { id: 'm1', label: 'Dana P.', hasFix: true, shown: true },
    { id: 'm3', label: 'Kit', hasFix: false, shown: false },
    { id: 'm2', label: 'Sam', hasFix: true, shown: false },
  ]);
  assert.equal(chaserRoster(MEMBERS, { allowlist: parseAllowlist('sam') }).mode, 'allowlist');
  assert.equal(chaserRoster(MEMBERS).mode, 'everyone');
});

test('selection saves drop unknown ids and refuse malformed bodies', () => {
  assert.deepEqual(normalizeSelection({ ids: ['m1', 'gone', 'm1'] }, ['m1', 'm2']), { ids: ['m1'] });
  assert.deepEqual(normalizeSelection({ ids: [] }, ['m1']), { ids: [] });
  assert.equal(normalizeSelection({ ids: 'm1' }, ['m1']), null);
  assert.equal(normalizeSelection({ ids: [7] }, ['m1']), null);
  assert.equal(normalizeSelection(null, ['m1']), null);
});
