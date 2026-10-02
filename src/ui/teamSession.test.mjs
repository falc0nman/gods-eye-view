import assert from 'node:assert/strict';
import test from 'node:test';
import { initTeamSession } from './teamSession.js';
function dom() {
  const nodes=[];
  return {nodes,getElementById:()=>({append:node=>nodes.push(node)}),createElement(tag){return {tag,events:{},addEventListener(name,fn){this.events[name]=fn;},remove(){const index=nodes.indexOf(this);if(index>=0)nodes.splice(index,1);}};}};
}
test('account controls are inert in local dev and after an aborted startup',async()=>{
  let calls=0;
  const fetchImpl=()=>{calls++;throw new Error('unexpected request');};
  (await initTeamSession({enabled:false,fetchImpl})).destroy();
  (await initTeamSession({enabled:true,fetchImpl,signal:AbortSignal.abort()})).destroy();
  assert.equal(calls,0);
});
test('server session text, CSRF logout and replacement controls have one lifecycle owner',async()=>{
  const documentRef=dom(),controller=new AbortController();let requests=0;
  const fetchImpl=async (url,options)=>{
    requests++;
    if(url==='/auth/providers')return Response.json({discord:true,session:{displayName:'<img onerror=alert(1)>',roles:['viewer'],csrfToken:'session-bound-token'}});
    assert.equal(url,'/api/auth/logout');assert.equal(options.method,'POST');assert.equal(options.headers['X-GEV-CSRF'],'session-bound-token');assert.equal(options.credentials,'same-origin');return Response.json({signedOut:true});
  };
  const owner=await initTeamSession({enabled:true,documentRef,fetchImpl,signal:controller.signal});
  assert.equal(documentRef.nodes.length,1);assert.equal(documentRef.nodes[0].textContent,'<img onerror=alert(1)> · Sign out');assert.equal(documentRef.nodes[0].innerHTML,undefined);
  await documentRef.nodes[0].events.click();
  assert.equal(requests,2);assert.equal(documentRef.nodes[0].tag,'a');assert.equal(documentRef.nodes[0].href,'/auth/login');
  controller.abort();assert.equal(documentRef.nodes.length,0);owner.destroy();
});
test('aborting a pending session request prevents a late account control',async()=>{
  const documentRef=dom(),controller=new AbortController();let finish;
  const pending=initTeamSession({enabled:true,documentRef,signal:controller.signal,fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
  controller.abort();finish(Response.json({discord:true}));(await pending).destroy();assert.equal(documentRef.nodes.length,0);
});
