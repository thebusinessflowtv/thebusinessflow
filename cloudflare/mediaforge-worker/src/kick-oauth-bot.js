// PeterLofi Kick OAuth, signed webhook queue, private host bridge.
// Dedicated to Kick: does not alter Twitch OAuth, streams, or encoders.
const enc=new TextEncoder();
const j=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const now=()=>Math.floor(Date.now()/1000);
const b64=(bytes)=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const un64=(s)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),x=>x.charCodeAt(0));
const auth=(env)=>!!(env.SESSION_SECRET&&env.KICK_CLIENT_ID&&env.KICK_CLIENT_SECRET&&env.KICK_OAUTH_REDIRECT_URI==="https://peterlofi.odsgn.com.br/api/oauth/kick/callback");
const cfgSecret=(env)=>String(env.KICK_BOT_BRIDGE_TOKEN||"");
async function sql(env){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS kick_oauth_pending (nonce TEXT PRIMARY KEY,verifier TEXT NOT NULL, expires INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS kick_oauth_tokens (login TEXT PRIMARY KEY, user_id TEXT NOT NULL, encrypted_token TEXT NOT NULL, expires INTEGER NOT NULL, connected_at TEXT NOT NULL, subscribed INTEGER NOT NULL DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS kick_chat_inbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_id TEXT NOT NULL, content TEXT NOT NULL, received_at INTEGER NOT NULL)").run();
}
async function aes(env){
  const seed=await crypto.subtle.digest("SHA-256",enc.encode("MediaForge:Kick:Tokens:v1:"+env.SESSION_SECRET));
  return crypto.subtle.importKey("raw",seed,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encrypt(env,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},await aes(env),enc.encode(JSON.stringify(value)));
  return JSON.stringify({v:1,iv:b64(iv),data:b64(data)});
}
async function decrypt(env,value){
  const v=JSON.parse(value);if(v.v!==1)throw Error("invalid_envelope");
  const data=await crypto.subtle.decrypt({name:"AES-GCM",iv:un64(v.iv)},await aes(env),un64(v.data));
  return JSON.parse(new TextDecoder().decode(data));
}
async function load(env){
  const row=await env.DB.prepare("SELECT login,user_id,encrypted_token,expires,subscribed FROM kick_oauth_tokens WHERE login='peterlofi'").first();
  return row?{row,token:await decrypt(env,row.encrypted_token)}:null;
}
async function refresh(env,session){
  const params=new URLSearchParams({grant_type:"refresh_token",client_id:env.KICK_CLIENT_ID,
    client_secret:env.KICK_CLIENT_SECRET,refresh_token:session.token.refresh_token});
  const response=await fetch("https://id.kick.com/oauth/token",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:params.toString(),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error("kick_refresh_http_"+response.status);
  const next=await response.json();
  if(!next.access_token||!next.refresh_token)throw Error("kick_refresh_missing_token");
  session.token={access_token:next.access_token,refresh_token:next.refresh_token,
    expires:now()+Number(next.expires_in||0)};
  await env.DB.prepare("UPDATE kick_oauth_tokens SET encrypted_token=?,expires=? WHERE login='peterlofi'")
    .bind(await encrypt(env,session.token),session.token.expires).run();
}
async function kickRequest(env,session,url,method="GET",payload=null){
  if(session.token.expires<now()+180)await refresh(env,session);
  async function go(){
    return fetch(url,{method,headers:{"authorization":"Bearer "+session.token.access_token,
      "content-type":"application/json"},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(15000)});
  }
  let response=await go();
  if(response.status===401){await refresh(env,session);response=await go()}
  let data={};try{data=await response.json()}catch(_){}
  return {status:response.status,data};
}
function page(ok,msg){return new Response("<!doctype html><html><head><meta charset='utf-8'></head><body style='font:20px system-ui;background:#151515;color:white;padding:3rem'><h2>"+(ok?"Connected":"Authorization failed")+"</h2><p>"+msg+"</p></body></html>",{status:ok?200:400,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});}
let publicKeyCache={key:null,at:0};
async function kickPublicKey(){
  if(publicKeyCache.key && Date.now()-publicKeyCache.at<900000)return publicKeyCache.key;
  const response=await fetch("https://api.kick.com/public/v1/public-key",{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error("kick_key_unavailable");
  const data=await response.json();
  const pem=String(data?.data?.public_key||"");
  const contents=pem.replace(/-----BEGIN PUBLIC KEY-----/g,"").replace(/-----END PUBLIC KEY-----/g,"").replace(/\s+/g,"");
  if(!contents||contents.length>4096)throw Error("invalid_public_key");
  const binary=Uint8Array.from(atob(contents),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey("spki",binary,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  publicKeyCache={key,at:Date.now()};
  return key;
}
async function webhook(request,env){
  if(request.method!=="POST")return j({error:"method_not_allowed"},405);
  if(!auth(env))return j({error:"kick_not_configured"},503);
  if(Number(request.headers.get("content-length")||0)>16384)return j({error:"too_large"},413);
  const msgId=String(request.headers.get("Kick-Event-Message-Id")||"");
  const stamp=String(request.headers.get("Kick-Event-Message-Timestamp")||"");
  const signature=String(request.headers.get("Kick-Event-Signature")||"");
  const evt=String(request.headers.get("Kick-Event-Type")||"");
  if(msgId.length<10||msgId.length>100||!/^[A-Za-z0-9_-]+$/.test(msgId)||signature.length>1024)return j({error:"invalid_headers"},400);
  const delta=Math.abs(Date.now()-Date.parse(stamp));
  if(!Number.isFinite(delta)||delta>5*60*1000)return j({error:"expired_event"},401);
  const raw=await request.text();if(raw.length>16384)return j({error:"too_large"},413);
  let valid=false;
  try{valid=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",await kickPublicKey(),
       Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),enc.encode(msgId+"."+stamp+"."+raw));}catch(_){}
  if(!valid)return j({error:"invalid_signature"},401);
  if(evt!=="chat.message.sent")return j({ok:true,ignored:true});
  let body={};try{body=JSON.parse(raw)}catch(_){return j({error:"invalid_json"},400)}
  const session=await load(env);
  if(!session)return j({error:"kick_oauth_missing"},503);
  if(String(body.broadcaster?.user_id||"")!==session.row.user_id)return j({error:"unexpected_broadcaster"},403);
  const chatter=String(body.sender?.user_id||""),messageId=String(body.message_id||msgId);
  const content=String(body.content||"").trim().slice(0,500);
  if(!chatter||!messageId||!content||chatter===session.row.user_id)return j({ok:true,ignored:true});
  await env.DB.prepare("INSERT OR IGNORE INTO kick_chat_inbox(id,user_id,message_id,content,received_at) VALUES(?,?,?,?,?)")
    .bind(msgId,chatter,messageId,content,now()).run();
  return j({ok:true});
}
export async function handleKick(request,env,url,requireAuth){
  const p=url.pathname;
  if(p==="/api/webhooks/kick")return webhook(request,env);
  if(!p.startsWith("/api/oauth/kick/"))return null;
  const op=p.slice("/api/oauth/kick/".length);
  if(!["callback","start","status","subscribe","bot/poll","bot/ack","bot/send"].includes(op))return j({error:"not_found"},404);
  if(!auth(env))return j({error:"kick_not_configured"},503);
  const bot=op.startsWith("bot/");
  if(bot){
    const secret=cfgSecret(env),supplied=String(request.headers.get("authorization")||"");
    if(secret.length<48||supplied!=="Bearer "+secret)return j({error:"unauthorized"},401);
  }else if(op!=="callback"){
    const session=await requireAuth(request,env);if(!session)return j({error:"unauthorized"},401);
  }
  try{
    await sql(env);
    if(op==="status"){
      const row=await env.DB.prepare("SELECT login,user_id,expires,subscribed,connected_at FROM kick_oauth_tokens WHERE login='peterlofi'").first();
      return j({connected:!!row,login:row?.login||null,subscribed:row?.subscribed===1,connected_at:row?.connected_at||null,token_expires_at:row?.expires||null});
    }
    if(op==="start"){
      if(request.method!=="POST")return j({error:"method_not_allowed"},405);
      const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge=b64(await crypto.subtle.digest("SHA-256",enc.encode(verifier)));
      const nonce=crypto.randomUUID();
      await env.DB.prepare("INSERT INTO kick_oauth_pending(nonce,verifier,expires) VALUES(?,?,?)").bind(nonce,verifier,now()+600).run();
      const u=new URL("https://id.kick.com/oauth/authorize");
      for(const [k,v] of Object.entries({response_type:"code",client_id:env.KICK_CLIENT_ID,
        redirect_uri:env.KICK_OAUTH_REDIRECT_URI,state:nonce,scope:"user:read chat:write events:subscribe",
        code_challenge:challenge,code_challenge_method:"S256"}))u.searchParams.set(k,v);
      return j({authorization_url:u.toString(),expires_in:600});
    }
    if(op==="callback"){
      if(request.method!=="GET")return page(false,"Invalid callback method.");
      const code=url.searchParams.get("code")||"",state=url.searchParams.get("state")||"";
      if(!code||code.length>2048||!state)return page(false,"Missing code or state. Start a new login.");
      const pending=await env.DB.prepare("SELECT verifier,expires FROM kick_oauth_pending WHERE nonce=?").bind(state).first();
      if(!pending||Number(pending.expires)<now())return page(false,"Authorization expired; start again.");
      const params=new URLSearchParams({grant_type:"authorization_code",client_id:env.KICK_CLIENT_ID,
        client_secret:env.KICK_CLIENT_SECRET,redirect_uri:env.KICK_OAUTH_REDIRECT_URI,
        code_verifier:pending.verifier,code});
      const tokenResp=await fetch("https://id.kick.com/oauth/token",{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body:params.toString(),signal:AbortSignal.timeout(15000)});
      if(!tokenResp.ok)return page(false,"Kick could not exchange authorization; retry from MediaForge.");
      const tok=await tokenResp.json();
      if(!tok.access_token||!tok.refresh_token)return page(false,"Missing renewable token.");
      const users=await fetch("https://api.kick.com/public/v1/users",{
        headers:{authorization:"Bearer "+tok.access_token},signal:AbortSignal.timeout(15000)});
      if(!users.ok)return page(false,"Could not verify Kick profile.");
      const profile=(await users.json()).data?.[0];
      if(String(profile?.name||"").toLowerCase()!=="peterlofi")return page(false,"Please authorize as PeterLofi.");
      const scopes=String(tok.scope||"").split(/[ ,]+/);
      if(!["chat:write","events:subscribe","user:read"].every(x=>scopes.includes(x)))
        return page(false,"Chat and event permissions were not granted.");
      const expires=now()+Number(tok.expires_in||3600);
      await env.DB.prepare("INSERT OR REPLACE INTO kick_oauth_tokens(login,user_id,encrypted_token,expires,connected_at,subscribed) VALUES(?,?,?,?,?,0)")
        .bind("peterlofi",String(profile.user_id),await encrypt(env,{access_token:tok.access_token,
          refresh_token:tok.refresh_token,expires}),expires,new Date().toISOString()).run();
      await env.DB.prepare("DELETE FROM kick_oauth_pending WHERE nonce=?").bind(state).run();
      return page(true,"PeterLofi Kick authorization saved. Return to the MediaForge terminal.");
    }
    if(op==="subscribe"){
      if(request.method!=="POST")return j({error:"method_not_allowed"},405);
      const session=await load(env);if(!session)return j({error:"not_authorized"},409);
      const r=await kickRequest(env,session,"https://api.kick.com/public/v1/events/subscriptions","POST",
        {events:[{name:"chat.message.sent",version:1}],method:"webhook"});
      if(r.status!==200&&r.status!==201)return j({ok:false,kick_http:r.status},502);
      const items=Array.isArray(r.data.data)?r.data.data:[];
      if(items.length && !items.some(x=>x.name==="chat.message.sent"&&!x.error))return j({ok:false,subscription_failed:true},502);
      await env.DB.prepare("UPDATE kick_oauth_tokens SET subscribed=1 WHERE login='peterlofi'").run();
      return j({ok:true,subscription_active:true});
    }
    if(!bot||request.method!=="POST")return j({error:"method_not_allowed"},405);
    const session=await load(env);if(!session)return j({error:"not_authorized"},409);
    if(op==="bot/poll"){
      const result=await env.DB.prepare("SELECT id,user_id,message_id,content FROM kick_chat_inbox ORDER BY received_at ASC LIMIT 12").all();
      return j({ok:true,broadcaster_id:session.row.user_id,events:result.results||[]});
    }
    let body={};try{body=await request.json()}catch(_){return j({error:"invalid_json"},400)}
    if(op==="bot/ack"){
      const eid=String(body.id||"");
      if(!/^[A-Za-z0-9_-]{10,100}$/.test(eid))return j({error:"invalid_id"},400);
      await env.DB.prepare("DELETE FROM kick_chat_inbox WHERE id=?").bind(eid).run();
      return j({ok:true});
    }
    if(op==="bot/send"){
      const message=String(body.message||"").trim();
      if(!message||message.length>450||/[\r\n]/.test(message))return j({error:"invalid_message"},400);
      const result=await kickRequest(env,session,"https://api.kick.com/public/v1/chat","POST",
        {type:"user",broadcaster_user_id:Number(session.row.user_id),content:message});
      if(result.status!==200)return j({ok:false,kick_http:result.status},502);
      return j({ok:result.data?.data?.is_sent===true||result.data?.is_sent===true});
    }
  }catch(e){
    console.error("KICK_INTEGRATION_ERROR",op,String(e?.name||"Error"));
    return j({error:"kick_integration_unavailable",stage:op},503);
  }
}
