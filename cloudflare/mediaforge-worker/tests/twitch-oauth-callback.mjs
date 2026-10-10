import assert from 'node:assert/strict';
import { handleTwitchOAuth } from '../src/twitch-oauth.js';

const uri='https://peterlofi.odsgn.com.br/api/oauth/twitch/callback';
const env={
  TWITCH_CLIENT_ID:'testid',TWITCH_CLIENT_SECRET:'testsecret',
  TWITCH_OAUTH_REDIRECT_URI:uri,SESSION_SECRET:'test_session_secret'
};
const noAuth=()=>{throw Error('callback must not require admin auth')};

async function check(method, body, url=uri) {
  const init={method};
  if(method==='POST'){
    init.body=body;
    init.headers={'content-type':'application/x-www-form-urlencoded'};
  }
  const request=new Request(url,init);
  const response=await handleTwitchOAuth(request,env,new URL(url),noAuth);
  assert.equal(response.status,400);
  assert.match(response.headers.get('content-type'),/text\/html/);
  assert.match(await response.text(),/Invalid OAuth authorization request/);
}
await check('GET',null);
await check('POST','code=invalid&state=invalid');
await check('POST','',uri+'?code=invalid&state=invalid');
const forbidden=await handleTwitchOAuth(
  new Request(uri,{method:'PUT'}),
  env,new URL(uri),noAuth
);
assert.equal(forbidden.status,405);
console.log('TWITCH_OAUTH_GET_POST_CALLBACK_TESTS_PASSED');


// Full OAuth completion regression: mock D1 and Twitch API, never actual tokens.
function mockDatabase(){
  const pending=new Map(),receipt=new Map(),tokens=new Map();
  return {pending,receipt,tokens,prepare(sql){
    let args=[];
    return {
      bind(...values){args=values;return this},
      async run(){
        if(sql.startsWith('CREATE TABLE'))return {meta:{changes:0}};
        if(sql.startsWith('INSERT INTO twitch_chat_oauth_pending')){
          pending.set(args[0],{nonce:args[0],expires_at:args[1],requested_by:args[2]});
          return {meta:{changes:1}};
        }
        if(sql.startsWith('DELETE FROM twitch_chat_oauth_pending')){
          const found=pending.delete(args[0]);
          return {meta:{changes:Number(found)}};
        }
        if(sql.startsWith('INSERT OR REPLACE INTO twitch_chat_oauth_tokens')){
          tokens.set(args[0],{broadcaster_id:args[0],login:args[1],encrypted_token:args[2],expires_at:args[4]});
          return {meta:{changes:1}};
        }
        if(sql.startsWith('INSERT OR IGNORE INTO twitch_chat_oauth_receipts')){
          receipt.set(args[0],{nonce:args[0],broadcaster_id:args[1]});
          return {meta:{changes:1}};
        }
        throw Error('unsupported D1 run query');
      },
      async first(){
        if(sql.startsWith('SELECT broadcaster_id FROM twitch_chat_oauth_receipts'))return receipt.get(args[0])||null;
        if(sql.startsWith('SELECT nonce FROM twitch_chat_oauth_pending')){
          const found=pending.get(args[0]);
          return found&&found.expires_at>=args[1]?found:null;
        }
        if(sql.startsWith('SELECT login,connected_at,expires_at FROM twitch_chat_oauth_tokens')){
          return [...tokens.values()].find(x=>x.login===args[0])||null;
        }
        throw Error('unsupported D1 first query');
      }
    };
  }};
}
const db=mockDatabase(), fullEnv={...env,DB:db};
const authRoute='https://peterlofi.odsgn.com.br/api/oauth/twitch/start';
const authRequest=new Request(authRoute);
const startResponse=await handleTwitchOAuth(authRequest,fullEnv,new URL(authRoute),async()=>({sub:'admin'}));
assert.equal(startResponse.status,200);
const authorize=new URL((await startResponse.json()).authorization_url);
assert.equal(authorize.searchParams.get('redirect_uri'),uri);
const state=authorize.searchParams.get('state');
const callback=uri+'?code=mock-authorization-code&state='+encodeURIComponent(state);
const originalFetch=globalThis.fetch;
let fetches=0;
try{
  globalThis.fetch=async (input)=>{
    fetches++;
    if(String(input).includes('/oauth2/token'))return new Response(JSON.stringify({
      access_token:'mock_access',refresh_token:'mock_refresh',scope:['user:read:chat','user:write:chat'],expires_in:3600
    }),{status:200,headers:{'content-type':'application/json'}});
    if(String(input).includes('/helix/users'))return new Response(JSON.stringify({data:[{id:'123456',login:'peterlofi'}]}),{status:200,headers:{'content-type':'application/json'}});
    throw Error('unexpected fetch');
  };
  const result=await handleTwitchOAuth(new Request(callback),fullEnv,new URL(callback),noAuth);
  assert.equal(result.status,200,await result.clone().text());
  assert.match(await result.text(),/Connected/);
  assert.equal(db.tokens.size,1);
  assert.equal(db.receipt.size,1);
  assert.equal(db.pending.size,0);
  assert.equal(fetches,2);
  const repeat=await handleTwitchOAuth(new Request(callback),fullEnv,new URL(callback),noAuth);
  assert.equal(repeat.status,200);
  assert.match(await repeat.text(),/already saved/);
  assert.equal(fetches,2,'repeated callback must not exchange again');

  const second=await handleTwitchOAuth(new Request(authRoute),fullEnv,new URL(authRoute),async()=>({sub:'admin'}));
  const newState=new URL((await second.json()).authorization_url).searchParams.get('state');
  const postCallback=uri+'?code=mock2&state='+encodeURIComponent(newState);
  const postRequest=new Request(postCallback,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'auth_result=success'});
  const postResult=await handleTwitchOAuth(postRequest,fullEnv,new URL(postCallback),noAuth);
  assert.equal(postResult.status,200,await postResult.clone().text());
  assert.match(await postResult.text(),/Connected/);

  const third=await handleTwitchOAuth(new Request(authRoute),fullEnv,new URL(authRoute),async()=>({sub:'admin'}));
  const errState=new URL((await third.json()).authorization_url).searchParams.get('state');
  const errorCallback=uri+'?code=temporary-network-error&state='+encodeURIComponent(errState);
  const oldPending=db.pending.size;
  globalThis.fetch=async()=>{throw Error('mock Twitch API downtime')};
  const failure=await handleTwitchOAuth(new Request(errorCallback),fullEnv,new URL(errorCallback),noAuth);
  assert.equal(failure.status,400);
  assert.match(await failure.text(),/exchange_twitch_code/);
  assert.equal(db.pending.size,oldPending,'state must survive network errors');
} finally {
  globalThis.fetch=originalFetch;
}
console.log('TWITCH_OAUTH_END_TO_END_IDEMPOTENCY_TESTS_PASSED');


// Diagnostic probe must use only dummy tokens, require admin auth, and never
// reveal credentials. No real Twitch requests are made by this test.
const probeUrl='https://peterlofi.odsgn.com.br/api/oauth/twitch/probe';
let requests=[];
const savedFetch=globalThis.fetch;
try{
  globalThis.fetch=async(url,init)=>{
    requests.push({url:String(url),method:init?.method||'GET',body:String(init?.body||'')});
    return new Response(null,{status:String(url).includes('/token')?400:401});
  };
  const response=await handleTwitchOAuth(new Request(probeUrl),fullEnv,
    new URL(probeUrl),async()=>({sub:'admin'}));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.runtime,'wrangler_workerd');
  assert.equal(data.results.length,3);
  assert.equal(data.results.filter(x=>x.reachable).length,3);
  assert.equal(requests.filter(x=>x.method==='POST').length,1);
  assert.match(requests.find(x=>x.method==='POST').body,/client_secret=invalid/);
  assert.ok(requests.every(x=>!x.body.includes('testsecret')));
  const denied=await handleTwitchOAuth(new Request(probeUrl),fullEnv,
    new URL(probeUrl),async()=>null);
  assert.equal(denied.status,401);
} finally {
  globalThis.fetch=savedFetch;
}
console.log('TWITCH_OAUTH_RUNTIME_PROBE_TESTS_PASSED');
