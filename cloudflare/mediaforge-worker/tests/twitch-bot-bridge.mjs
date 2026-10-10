import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleTwitchBotBridge } from '../src/twitch-bot-bridge.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const b64=b=>Buffer.from(b).toString('base64url');
const sessionSecret='test_session_secret_very_long', clientId='someid',secret='test_private_bridge_token_'.repeat(4);
const keySeed=await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode('MediaForge:TwitchChat:v1:'+sessionSecret));
const key=await crypto.subtle.importKey('raw',keySeed,{name:'AES-GCM'},false,['encrypt']);
const iv=crypto.getRandomValues(new Uint8Array(12));
const raw=JSON.stringify({access_token:'mock_access',refresh_token:'mock_refresh',
  expires_at:Math.floor(Date.now()/1000)+3600});
const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(raw));
const stored=JSON.stringify({version:1,iv:b64(iv),ciphertext:b64(ciphertext)});
const env={
  TWITCH_BOT_BRIDGE_TOKEN:secret, TWITCH_CLIENT_ID:clientId,
  TWITCH_CLIENT_SECRET:'fake_client_secret',SESSION_SECRET:sessionSecret,
  DB:{prepare(sql){
    assert.match(sql,/SELECT broadcaster_id,encrypted_token,scope_json,expires_at/);
    return {bind(login){assert.equal(login,'peterlofi');return {
      async first(){return {broadcaster_id:'1234',encrypted_token:stored,scope_json:'[]',
          expires_at:Math.floor(Date.now()/1000)+3600}}
    }}};
  }}
};
let called=[];
const previous=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
  called.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
  if(String(url).includes('/eventsub/subscriptions'))
    return new Response(JSON.stringify({data:[{id:'subscription'}]}),{status:202});
  if(String(url).includes('/chat/messages'))
    return new Response(JSON.stringify({data:[{message_id:'m123',is_sent:true}]}),{status:200});
  throw Error('unknown outbound');
};
const base='https://peterlofi.odsgn.com.br/api/oauth/twitch/bot/';
const req=(action,body={},auth=true)=>new Request(base+action,{
  method:'POST',headers:{'authorization':'Bearer '+(auth?secret:'invalid'),
    'content-type':'application/json'},body:JSON.stringify(body)
});
async function run(action,body,auth=true){
  const request=req(action,body,auth);
  const response=await handleTwitchBotBridge(request,env,new URL(request.url));
  return [response.status,await response.json()];
}
try{
  const [unauth]=await run('status',{},false);
  assert.equal(unauth,401);
  const [statusCode,status]=await run('status');
  assert.equal(statusCode,200);
  assert.equal(status.broadcaster_id,'1234');
  assert.ok(!JSON.stringify(status).includes('mock_access'));
  assert.ok(!JSON.stringify(status).includes('mock_refresh'));
  const [invalidCode]=await run('subscribe',{session_id:'?'});
  assert.equal(invalidCode,400);
  const [subCode,sub]=await run('subscribe',{session_id:'abc1234567890'});
  assert.equal(subCode,200);
  assert.equal(sub.ok,true);
  assert.deepEqual(called[0].body.condition,{broadcaster_user_id:'1234',user_id:'1234'});
  assert.equal(called[0].headers.authorization,'Bearer mock_access');
  const [sentCode,sent]=await run('send',{message:'Now playing: Arcade Nights'});
  assert.equal(sentCode,200);
  assert.equal(sent.ok,true);
  assert.equal(called[1].body.sender_id,'1234');
  assert.equal(called[1].body.message,'Now playing: Arcade Nights');
  const [invalidSend]=await run('send',{message:'bad\nnew line'});
  assert.equal(invalidSend,400);
  console.log('TWITCH_BOT_BRIDGE_TESTS_PASSED');
}finally{
  globalThis.fetch=previous;
}
