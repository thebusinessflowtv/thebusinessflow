// PeterLofi Twitch OAuth Authorization Code flow. No tokens are returned to clients.
const enc=new TextEncoder();
const respond=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const base64=(x)=>btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const b64bytes=(s)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const formPage=(ok,message)=>new Response(
  "<!doctype html><title>PeterLofi Bot</title><meta charset=utf-8><main style='font:18px system-ui;background:#17191D;color:white;padding:3rem'><h1>"+
  (ok?"Connected":"Authorization failed")+"</h1><p>"+message+"</p></main>",
  {status:ok?200:400,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"}}
);
async function signingKey(secret) {
  return crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
async function tokenCipher(secret){
  const bytes=await crypto.subtle.digest("SHA-256",enc.encode("MediaForge:TwitchChat:v1:"+secret));
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt"]);
}
async function createTables(env){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS twitch_chat_oauth_pending (nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,requested_by TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS twitch_chat_oauth_tokens (broadcaster_id TEXT PRIMARY KEY,login TEXT NOT NULL,encrypted_token TEXT NOT NULL,scope_json TEXT NOT NULL,expires_at INTEGER NOT NULL,connected_at TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS twitch_chat_oauth_receipts (nonce TEXT PRIMARY KEY,broadcaster_id TEXT NOT NULL,completed_at TEXT NOT NULL)").run();
}
function config(env){
  const clientId=String(env.TWITCH_CLIENT_ID||"").trim(),clientSecret=String(env.TWITCH_CLIENT_SECRET||"").trim();
  const redirectUri=String(env.TWITCH_OAUTH_REDIRECT_URI||"").trim(),secret=String(env.SESSION_SECRET||"");
  if(!clientId||!clientSecret||!secret||!redirectUri.startsWith("https://"))return null;
  return {clientId,clientSecret,redirectUri,secret};
}
export async function handleTwitchOAuth(request,env,url,requireAuth){
  const route=url.pathname;
  if(!["/api/oauth/twitch/start","/api/oauth/twitch/status","/api/oauth/twitch/callback"].includes(route))return null;
  const isCallback=route==="/api/oauth/twitch/callback";
  // Twitch normally redirects by GET. Some OAuth clients and frontends send
  // application/x-www-form-urlencoded POST callbacks. Accept either securely
  // and never interpret a POST as a new authorization start.
  if(request.method!=="GET"&&!(isCallback&&request.method==="POST"))
    return respond({error:"method_not_allowed"},405);
  let callbackParams=url.searchParams;
  if(isCallback&&request.method==="POST"){
    const contentType=String(request.headers.get("content-type")||"").toLowerCase();
    if(!contentType.startsWith("application/x-www-form-urlencoded"))
      return formPage(false,"Unsupported OAuth callback format. Please restart authorization.");
    const raw=await request.text();
    if(raw.length>4096)return formPage(false,"OAuth callback was too large.");
    const posted=new URLSearchParams(raw);
    // Form parameters take precedence on POST to prevent ambiguous duplicates.
    if(posted.has("code")||posted.has("state")||posted.has("error"))callbackParams=posted;
  }
  const cfg=config(env);
  if(!cfg)return respond({error:"twitch_oauth_not_configured"},503);
  if(route!=="/api/oauth/twitch/callback"){
    const session=await requireAuth(request,env);
    if(!session)return respond({error:"unauthorized"},401);
    await createTables(env);
    if(route==="/api/oauth/twitch/status"){
      const row=await env.DB.prepare("SELECT login,connected_at,expires_at FROM twitch_chat_oauth_tokens WHERE login=?").bind("peterlofi").first();
      return respond({connected:!!row,login:row?.login||null,connected_at:row?.connected_at||null,expires_at:row?.expires_at||null});
    }
    const nonce=crypto.randomUUID(),exp=Math.floor(Date.now()/1000)+600,body=nonce+"."+exp;
    await env.DB.prepare("INSERT INTO twitch_chat_oauth_pending(nonce,expires_at,requested_by) VALUES(?,?,?)").bind(nonce,exp,String(session.sub)).run();
    const sig=base64(await crypto.subtle.sign("HMAC",await signingKey(cfg.secret),enc.encode(body)));
    const authorize=new URL("https://id.twitch.tv/oauth2/authorize");
    authorize.searchParams.set("client_id",cfg.clientId);
    authorize.searchParams.set("response_type","code");
    authorize.searchParams.set("scope","user:read:chat user:write:chat");
    authorize.searchParams.set("redirect_uri",cfg.redirectUri);
    authorize.searchParams.set("state",body+"."+sig);
    return respond({authorization_url:authorize.toString(),expires_in:600});
  }
  if(callbackParams.has("error"))return formPage(false,"Twitch authorization was declined.");
  const code=callbackParams.get("code")||"",state=callbackParams.get("state")||"",parts=state.split(".");
  if(!code||code.length>2048||parts.length!==3||!/^[a-f0-9-]{36}$/.test(parts[0])||!/^\d{10}$/.test(parts[1]))
    return formPage(false,"Invalid OAuth authorization request.");
  const [nonce,expires,sig]=parts,ts=Math.floor(Date.now()/1000);
  if(Number(expires)<ts||Number(expires)>ts+600)return formPage(false,"OAuth session expired.");
  let valid=false;
  try{valid=await crypto.subtle.verify("HMAC",await signingKey(cfg.secret),b64bytes(sig),enc.encode(nonce+"."+expires));}catch(_){}
  if(!valid)return formPage(false,"OAuth state verification failed.");
  // Never consume a one-time state BEFORE exchanging and persisting tokens.
  // An upstream error previously caused subsequent retries to say "already used".
  await createTables(env);
  const receipt=await env.DB.prepare("SELECT broadcaster_id FROM twitch_chat_oauth_receipts WHERE nonce=?").bind(nonce).first();
  if(receipt)return formPage(true,"PeterLofi Twitch authorization was already saved. You may close this window.");
  const pending=await env.DB.prepare("SELECT nonce FROM twitch_chat_oauth_pending WHERE nonce=? AND expires_at>=?").bind(nonce,ts).first();
  if(!pending)return formPage(false,"This authorization session expired. Start a new authorization from MediaForge.");
  const post=new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.clientSecret,code,
    grant_type:"authorization_code",redirect_uri:cfg.redirectUri});
  const exchange=await fetch("https://id.twitch.tv/oauth2/token",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:post.toString()
  });
  if(!exchange.ok)return formPage(false,"Twitch could not complete the authorization. Please try again.");
  const token=await exchange.json();
  if(!token.access_token||!token.refresh_token)return formPage(false,"Missing renewable Twitch token.");
  const profileResponse=await fetch("https://api.twitch.tv/helix/users",{
    headers:{"authorization":"Bearer "+token.access_token,"client-id":cfg.clientId}
  });
  if(!profileResponse.ok)return formPage(false,"Could not verify the Twitch account.");
  const profile=(await profileResponse.json()).data?.[0];
  if(String(profile?.login||"").toLowerCase()!=="peterlofi")
    return formPage(false,"Log in with the PeterLofi broadcaster account.");
  const scopes=Array.isArray(token.scope)?token.scope:[];
  if(!["user:read:chat","user:write:chat"].every(x=>scopes.includes(x)))
    return formPage(false,"Required chat permissions were not granted.");
  const expiration=ts+Number(token.expires_in||0),iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},await tokenCipher(cfg.secret),
    enc.encode(JSON.stringify({access_token:token.access_token,refresh_token:token.refresh_token,expires_at:expiration})));
  const stored=JSON.stringify({version:1,iv:base64(iv),ciphertext:base64(encrypted)});
  await env.DB.prepare("INSERT OR REPLACE INTO twitch_chat_oauth_tokens(broadcaster_id,login,encrypted_token,scope_json,expires_at,connected_at) VALUES(?,?,?,?,?,?)")
    .bind(String(profile.id),String(profile.login),stored,JSON.stringify(scopes),expiration,new Date().toISOString()).run();
  // Record success before consuming state, so callback refresh is idempotent.
  await env.DB.prepare("INSERT OR IGNORE INTO twitch_chat_oauth_receipts(nonce,broadcaster_id,completed_at) VALUES(?,?,?)")
    .bind(nonce,String(profile.id),new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM twitch_chat_oauth_pending WHERE nonce=?").bind(nonce).run();
  return formPage(true,"PeterLofi Twitch authorization saved securely. You may close this window.");
}
