import assert from 'node:assert/strict';
import test from 'node:test';
import { keySetupRequirement } from './keySetupCore.mjs';

test('missing credentials direct operators to server configuration', () => {
 assert.equal(keySetupRequirement('cesium-ion'), 'Needs CESIUM_ION_TOKEN — configure it on the server');
 assert.equal(keySetupRequirement('unknown'), '');
});
test('the admission gate refuses every non-local shape, one assertion per refusal', async () => {
  const { admitLocalRosterRequest } = await import('./keySetupCore.mjs');
  const local = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
    env: {},
  };
  assert.equal(admitLocalRosterRequest(local).ok, true, 'the honest local request is admitted');
  assert.equal(admitLocalRosterRequest({ ...local, method: 'GET', contentType: undefined }).ok, true, 'local GET needs no content type');
  assert.equal(admitLocalRosterRequest({ ...local, origin: undefined }).ok, false, 'POST without Origin is refused');
  assert.equal(admitLocalRosterRequest({ ...local, method: 'GET', origin: undefined, contentType: undefined }).ok, true, 'local GET may omit Origin');
  assert.equal(admitLocalRosterRequest({ ...local, remoteAddress: '::ffff:127.0.0.1', hostHeader: '[::1]:4173', origin: 'http://[::1]:4173' }).ok, true, 'IPv6 loopback forms are local');

  // Tunnel/LAN sharing of any kind removes the surface outright — tunnel
  // traffic arrives FROM loopback, so no socket check can carry this boundary.
  assert.equal(admitLocalRosterRequest({ ...local, env: { PINOKIO_SHARE_CLOUDFLARE: 'true' } }).ok, false, 'sharing disables the surface');
  assert.equal(admitLocalRosterRequest({ ...local, env: { PINOKIO_SHARE_LOCAL: '1' } }).ok, false, 'LAN sharing disables the surface');
  // A LAN peer reaching a wide-bound server.
  assert.equal(admitLocalRosterRequest({ ...local, remoteAddress: '192.168.1.20' }).ok, false, 'non-loopback socket refused');
  // Tunnel and DNS-rebinding traffic carries a foreign Host over a loopback socket.
  assert.equal(admitLocalRosterRequest({ ...local, hostHeader: 'abc.trycloudflare.com' }).ok, false, 'foreign Host refused');
  assert.equal(admitLocalRosterRequest({ ...local, hostHeader: 'workstation.local:4173' }).ok, false, 'non-localhost hostnames refused');
  assert.equal(admitLocalRosterRequest({ ...local, hostHeader: '' }).ok, false, 'missing Host refused');
  assert.equal(admitLocalRosterRequest({ ...local, hostHeader: '[::1].evil:4173' }).ok, false, 'malformed bracketed Host refused');
  // A hostile web page POSTing at localhost carries its own Origin.
  assert.equal(admitLocalRosterRequest({ ...local, origin: 'https://evil.example' }).ok, false, 'cross-origin refused');
  assert.equal(admitLocalRosterRequest({ ...local, origin: 'not a url' }).ok, false, 'unparseable Origin refused');
  assert.equal(admitLocalRosterRequest({ ...local, origin: 'http://localhost:4174' }).ok, false, 'cross-port Origin refused');
  assert.equal(admitLocalRosterRequest({ ...local, origin: 'https://localhost:4173' }).ok, false, 'cross-scheme Origin refused');
  assert.equal(admitLocalRosterRequest({ ...local, origin: 'http://127.0.0.1:4173' }).ok, false, 'different loopback host Origin refused');
  // A simple-request POST (no JSON content type) is the CSRF write shape.
  const noJson = admitLocalRosterRequest({ ...local, contentType: 'text/plain' });
  assert.equal(noJson.ok, false, 'non-JSON POST refused');
  assert.equal(noJson.status, 415);
});
test('the sharing gate treats a real PINOKIO_SHARE_VAR as sharing, but not the empty/sentinel normal state', async () => {
  const { admitLocalRosterRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json',
  };
  // The ordinary launch states: unset, empty, or the explicit disabled sentinel.
  assert.equal(admitLocalRosterRequest({ ...base, env: {} }).ok, true, 'unset SHARE_VAR is normal');
  assert.equal(admitLocalRosterRequest({ ...base, env: { PINOKIO_SHARE_VAR: '' } }).ok, true, 'empty SHARE_VAR is normal');
  assert.equal(admitLocalRosterRequest({ ...base, env: { PINOKIO_SHARE_VAR: '__gev_sharing_disabled__' } }).ok, true, 'the disabled sentinel is normal');
  // A real tunnel var disables the surface.
  assert.equal(admitLocalRosterRequest({ ...base, env: { PINOKIO_SHARE_VAR: 'MY_TUNNEL_TOKEN' } }).ok, false, 'a real share var is sharing');
});
test('the gate refuses proxied requests even from a loopback socket with local headers', async () => {
  const { admitLocalRosterRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json', env: {},
  };
  assert.equal(admitLocalRosterRequest(base).ok, true, 'no proxy headers → admitted');
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
    assert.equal(
      admitLocalRosterRequest({ ...base, proxyHeaders: { [header]: 'anything' } }).ok,
      false,
      `${header} present → refused`,
    );
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(admitLocalRosterRequest({ ...base, proxyHeaders: { 'x-forwarded-for': '' } }).ok, true);
});