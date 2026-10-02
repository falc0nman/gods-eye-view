import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { identityConfig } from '../../backend/identity/config.js';
import { identityProviders } from '../../backend/identity/providers.js';
import { opaque, digest, seal, unseal, equal } from '../../backend/identity/security.js';
import { readFileSync, existsSync } from 'node:fs';
import { localProviderPlugins } from '../../server/providers/local.js';

const env = { GEV_PUBLIC_ORIGIN: 'https://gev.example', GEV_AUTH_KEY: 'ab'.repeat(32), GEV_GOOGLE_CLIENT_ID: 'test-audience', GEV_GOOGLE_CLIENT_SECRET: 'fixture-google', GEV_DISCORD_CLIENT_ID:'fixture-id', GEV_DISCORD_CLIENT_SECRET:'fixture-discord', GEV_DISCORD_BOT_TOKEN:'fixture-bot', GEV_DISCORD_GUILD_ID:'123' };
test('production configuration requires HTTPS and host-prefixed cookies', () => {
  const c=identityConfig(env);
  assert.equal(c.cookieName,'__Host-gev_session');
  assert.equal(c.discord.enabled,true);
  assert.throws(()=>identityConfig({...env,GEV_PUBLIC_ORIGIN:'http://gev.example'}));
  assert.throws(()=>identityConfig({...env,GEV_SESSION_COOKIE:'gev_session'}));
  assert.throws(()=>identityConfig({...env,GEV_AUTH_KEY:'short'}));
  assert.equal(identityConfig({GEV_PUBLIC_ORIGIN:'http://localhost:4173'}).google.enabled,false);
});
test('provider tokens are authenticated and bound to a single hashed session', () => {
  const key=identityConfig(env).key, token=opaque(),hash=digest(token),value={access:'fixture-secret',refresh:'fixture-refresh'};
  const encrypted=seal(value,key,hash);
  assert.equal(encrypted.includes(value.access),false);
  assert.deepEqual(unseal(encrypted,key,hash),value);
  assert.throws(()=>unseal(encrypted,key,digest(opaque())));
  assert.throws(()=>unseal(encrypted,Buffer.alloc(32),hash));
  assert.equal(equal('a','é'),false);
  assert.equal(equal('same','same'),true);
});
test('Google validates signed identity, nonce, issuer, audience, expiry and authorized party', async () => {
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const {privateKey:forged}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);jwk.kid='fixture';
  const keys=createLocalJWKSet({keys:[jwk]});
  const config=identityConfig(env),flow={nonce:'test-nonce',verifier:'fixture-verifier',redirectUri:'https://gev.example/auth/google/callback'};
  let idToken;
  const provider=identityProviders(config,{keys,fetchImpl:async (url,options)=>{
    assert.equal(url,'https://oauth2.googleapis.com/token');
    assert.equal(options.redirect,'error');
    assert.equal(options.body.get('code_verifier'),flow.verifier);
    assert.equal(options.body.get('client_secret'),'fixture-google');
    return Response.json({id_token:idToken});
  }});
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'https://accounts.google.com',aud:env.GEV_GOOGLE_CLIENT_ID,sub:'stable-subject',nonce:flow.nonce,iat:now,exp:now+300,email_verified:true,name:'Operator'};
  const sign=(payload,key=privateKey)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(key);
  idToken=await sign(claims);
  assert.deepEqual(await provider.exchange('google','code',flow),{subject:'stable-subject',displayName:'Operator'});
  for(const patch of [{nonce:'wrong'},{iss:'https://attacker.example'},{aud:'wrong'},{exp:now-10},{iat:now-900},{email_verified:false},{azp:'wrong'},{aud:[env.GEV_GOOGLE_CLIENT_ID,'other']}]){
    idToken=await sign({...claims,...patch});
    await assert.rejects(provider.exchange('google','code',flow));
  }
  idToken=await sign(claims,forged);
  await assert.rejects(provider.exchange('google','code',flow));
  const auth=new URL(provider.authorization('google',{state:'state',nonce:flow.nonce,challenge:'challenge',redirectUri:flow.redirectUri}));
  assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.equal(auth.searchParams.has('client_secret'),false);
});
test('Discord refreshes tokens and gets authoritative roles with bot credentials', async () => {
  const config=identityConfig(env);let missing=false,wrongUser=false,refreshed=false;
  const provider=identityProviders(config,{fetchImpl:async (url,options)=>{
    assert.equal(options.redirect,'error');
    if(url.endsWith('/oauth2/token')) { assert.equal(options.body.get('grant_type'),'refresh_token');refreshed=true;return Response.json({access_token:'renewed',refresh_token:'new-refresh',expires_in:3600,token_type:'Bearer'}); }
    if(url.endsWith('/users/@me')) {assert.equal(options.headers.Authorization,'Bearer renewed');return Response.json({id:wrongUser?'999':'456'});}
    assert.equal(url,'https://discord.com/api/v10/guilds/123/members/456');
    assert.equal(options.headers.Authorization,'Bot fixture-bot');
    return missing?new Response('',{status:404}):Response.json({user:{id:'456'},roles:['789'],pending:false});
  }});
  const original={access:'old',refresh:'refresh',expiresAt:Date.now()-1000};
  const result=await provider.revalidate('456',original);
  assert.equal(refreshed,true);assert.deepEqual(result.roles,['789']);assert.equal(result.tokens.refresh,'new-refresh');
  missing=true;await assert.rejects(provider.revalidate('456',result.tokens),e=>e.status===401);
  missing=false;wrongUser=true;await assert.rejects(provider.revalidate('456',result.tokens));
});
test('credential writes and editor exports are removed from both application surfaces', () => {
  const root=new URL('../../',import.meta.url);
  for(const file of ['server/standalone/key-setup.js','src/keySetup.js','src/ui/templates/provider-settings.html']) assert.equal(existsSync(new URL(file,root)),false);
  assert.equal(localProviderPlugins().some(p=>p.name==='gev-key-setup'),false);
  const pkg=JSON.parse(readFileSync(new URL('package.json',root)));
  assert.equal(pkg.exports['./standalone/settings'],undefined);
  assert.equal(pkg.exports['./server/standalone/key-setup'],undefined);
  assert.doesNotMatch(readFileSync(new URL('index.html',root),'utf8'),/provider-settings/);
});
