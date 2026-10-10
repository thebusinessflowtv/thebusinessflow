// Private loopback-facing bridge for PeterLofi Twitch EventSub bot.
// A separate bot client talks to this API using a strong random bearer secret.
// OAuth access and refresh tokens NEVER leave the MediaForge Worker.
// Never expose this bridge to an unauthenticated client.
const encoder = new TextEncoder();
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const toBytes=(s)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),x=>x.charCodeAt(0));
const toBase64=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
async function cryptoKey(secret){
  const seed=await crypto.subtle.digest("SHA-256",encoder.encode("MediaForge:TwitchChat:v1:"+secret));
  return crypto.subtle.importKey("raw",seed,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptToken(env,data){
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await cryptoKey(env.SESSION_SECRET);
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(JSON.stringify(data)));
  return JSON.stringify({version:1,iv:toBase64(iv),ciphertext:toBase64(encrypted)});
}
async function decryptToken(env,data){
  const stored=JSON.parse(data);
  if(stored.version!==1||!stored.iv||!stored.ciphertext)throw Error("invalid encrypted token");
  const key=await cryptoKey(env.SESSION_SECRET);
  const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:toBytes(stored.iv)},key,toBytes(stored.ciphertext));
  const tokens=JSON.parse(new TextDecoder().decode(plaintext));
  if(!tokens.access_token||!tokens.refresh_token)throw Error("token missing");
  return tokens;
}
async function load(env){
  const row=await env.DB.prepare("SELECT broadcaster_id,encrypted_token,scope_json,expires_at FROM twitch_chat_oauth_tokens WHERE login=?").bind("peterlofi").first();
  if(!row)return null;
  const tokens=await decryptToken(env,row.encrypted_token);
  return {id:String(row.broadcaster_id),row,tokens};
}
async function refresh(env,session){
  const body=new URLSearchParams({
    client_id:String(env.TWITCH_CLIENT_ID),client_secret:String(env.TWITCH_CLIENT_SECRET),
    grant_type:"refresh_token",refresh_token:session.tokens.refresh_token,
  });
  const response=await fetch("https://id.twitch.tv/oauth2/token",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:body.toString(),
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw Error("refresh_http_"+response.status);
  const value=await response.json();
  if(!value.access_token||!value.refresh_token)throw Error("refresh_incomplete");
  const expires_at=Math.floor(Date.now()/1000)+Number(value.expires_in||0);
  session.tokens={access_token:value.access_token,refresh_token:value.refresh_token,expires_at};
  await env.DB.prepare("UPDATE twitch_chat_oauth_tokens SET encrypted_token=?,expires_at=? WHERE broadcaster_id=?").bind(
    await encryptToken(env,session.tokens),expires_at,session.id
  ).run();
}
async function twitchRequest(env,session,endpoint,body){
  if(Number(session.tokens.expires_at||session.row.expires_at)<Date.now()/1000+180)await refresh(env,session);
  const options=()=>({
    method:"POST",
    headers:{"authorization":"Bearer "+session.tokens.access_token,
      "client-id":String(env.TWITCH_CLIENT_ID),"content-type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12000)
  });
  let result=await fetch(endpoint,options());
  if(result.status===401){await refresh(env,session);result=await fetch(endpoint,options());}
  let data={};
  try{data=await result.json()}catch(_){}
  return {status:result.status,data};
}
function constantTimeEqual(left,right){
  const a=encoder.encode(left),b=encoder.encode(right);
  if(a.length!==b.length)return false;
  let n=0;for(let i=0;i<a.length;i++)n|=a[i]^b[i];return n===0;
}
export async function handleTwitchBotBridge(request,env,url){
  const route=url.pathname;
  const prefix="/api/oauth/twitch/bot/";
  if(!route.startsWith(prefix))return null;
  if(!["subscribe","send","status"].includes(route.slice(prefix.length)))return reply({error:"unknown_route"},404);
  const secret=String(env.TWITCH_BOT_BRIDGE_TOKEN||"");
  if(secret.length<48)return reply({error:"bot_bridge_not_configured"},503);
  const bearer=String(request.headers.get("authorization")||"");
  if(!constantTimeEqual(bearer,"Bearer "+secret))return reply({error:"unauthorized"},401);
  if(request.method!=="POST")return reply({error:"method_not_allowed"},405);
  const ct=String(request.headers.get("content-type")||"");
  if(!ct.startsWith("application/json"))return reply({error:"json_required"},415);
  let value={};
  try{
    if(Number(request.headers.get("content-length")||0)>3072)return reply({error:"request_too_large"},413);
    const raw=await request.text();
    if(raw.length>3072)return reply({error:"request_too_large"},413);
    value=JSON.parse(raw);
  }catch(_){return reply({error:"invalid_json"},400);}
  try{
    const session=await load(env);
    if(!session)return reply({error:"twitch_not_authorized"},409);
    if(route.endsWith("/status")){
      return reply({connected:true,login:"peterlofi",broadcaster_id:session.id,
        token_expires_at:Number(session.tokens.expires_at||session.row.expires_at)});
    }
    if(route.endsWith("/subscribe")){
      const session_id=String(value.session_id||"");
      if(!/^[A-Za-z0-9_-]{8,256}$/.test(session_id))return reply({error:"invalid_session_id"},400);
      const payload={
        type:"channel.chat.message",version:"1",
        condition:{broadcaster_user_id:session.id,user_id:session.id},
        transport:{method:"websocket",session_id}
      };
      const result=await twitchRequest(env,session,"https://api.twitch.tv/helix/eventsub/subscriptions",payload);
      if(result.status!==202&&result.status!==200){
        console.warn("TWITCH_BOT_SUBSCRIBE_FAILED",result.status);
        return reply({ok:false,twitch_http:result.status},502);
      }
      return reply({ok:true,broadcaster_id:session.id,eventsub_http:result.status});
    }
    if(route.endsWith("/send")){
      const text=String(value.message||"").trim();
      if(!text||text.length>450||/[\r\n]/.test(text))return reply({error:"invalid_chat_message"},400);
      const payload={broadcaster_id:session.id,sender_id:session.id,message:text};
      const result=await twitchRequest(env,session,"https://api.twitch.tv/helix/chat/messages",payload);
      if(result.status!==200){
        console.warn("TWITCH_BOT_SEND_FAILED",result.status);
        return reply({ok:false,twitch_http:result.status},502);
      }
      const sent=Array.isArray(result.data.data)?result.data.data[0]:null;
      return reply({ok:sent?.is_sent===true,message_id:sent?.message_id||null});
    }
  }catch(err){
    // NEVER log or return raw errors, bodies, authorization headers or tokens.
    console.error("TWITCH_BOT_BRIDGE_ERROR",String(err?.name||"Error"));
    return reply({error:"twitch_bot_bridge_unavailable"},503);
  }
}
