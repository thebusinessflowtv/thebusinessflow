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
