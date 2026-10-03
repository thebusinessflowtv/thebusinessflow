const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
}
function b64url(bytes) { let bin=''; for(const b of bytes) bin+=String.fromCharCode(b); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function b64json(value) { return b64url(enc.encode(JSON.stringify(value))); }
function base64Utf8(text) { let bin=''; for(const b of enc.encode(text)) bin+=String.fromCharCode(b); return btoa(bin); }
async function hmac(secret,value){const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value))));}
async function signSession(email,secret){const now=Math.floor(Date.now()/1000),h=b64json({alg:'HS256',typ:'MFG'}),p=b64json({sub:email,iat:now,exp:now+604800}),s=await hmac(secret,`${h}.${p}`);return `${h}.${p}.${s}`;}
function decodeB64url(s){const p=s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4);return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p),c=>c.charCodeAt(0))));}
async function verifySession(token,secret){try{const [h,p,s]=token.split('.');if(!h||!p||!s)return null;if(s!==await hmac(secret,`${h}.${p}`))return null;const x=decodeB64url(p);if(!x?.sub||Number(x.exp||0)<Math.floor(Date.now()/1000))return null;return x;}catch(_){return null;}}
function corsHeaders(request,env){const origin=request.headers.get('origin')||'',allowed=env.FRONTEND_ORIGIN||'https://thebusinessflowtv.github.io',allowOrigin=origin&&(origin===allowed||origin.startsWith(allowed+':'))?origin:allowed;return {'access-control-allow-origin':allowOrigin,'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','access-control-allow-headers':'authorization,content-type,x-upload-name,x-upload-type','access-control-max-age':'86400','vary':'Origin'};}
async function bodyJson(request){try{return await request.json();}catch(_){return {};}}
function bearer(request){const h=request.headers.get('authorization')||'';return h.toLowerCase().startsWith('bearer ')?h.slice(7).trim():'';}
async function requireAuth(request,env){const t=bearer(request);return t?verifySession(t,env.SESSION_SECRET||''):null;}

function githubHeaders(env){return {'authorization':`Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'MediaForge-Cloudflare-Worker','content-type':'application/json'};}
async function githubQueueFile(env,path,payload,message){
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no Worker.');
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic',api=`https://api.github.com/repos/${repo}/contents/${path}`;
  let sha='';
  try{const g=await fetch(api+'?ref=main',{headers:githubHeaders(env)});if(g.ok)sha=String((await g.json()).sha||'');}catch(_){}
  const body={message:message||`mediaforge: update ${path}`,content:base64Utf8(JSON.stringify(payload,null,2)),branch:'main'};if(sha)body.sha=sha;
  const res=await fetch(api,{method:'PUT',headers:githubHeaders(env),body:JSON.stringify(body)});
  if(!res.ok){const text=await res.text();throw new Error(`GitHub queue falhou (${res.status}): ${text.slice(0,500)}`);}return res.json();
}
async function githubDispatchWorkflow(env,workflow,inputs){
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no Worker.');
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic';
  const api=`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const res=await fetch(api,{method:'POST',headers:githubHeaders(env),body:JSON.stringify({ref:'main',inputs})});
  if(!res.ok){const text=await res.text();throw new Error(`GitHub dispatch falhou (${res.status}): ${text.slice(0,500)}`);}
  return true;
}
async function fetchGithubJson(env,path){
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic';
  try{const r=await fetch(`https://raw.githubusercontent.com/${repo}/main/${path}?ts=${Date.now()}`,{headers:{'user-agent':'MediaForge-Cloudflare-Worker'}});return r.ok?await r.json():null;}catch(_){return null;}
}
async function getCatalog(env){const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic',r=await fetch(`https://raw.githubusercontent.com/${repo}/main/control/mediaforge-catalog.json?ts=${Date.now()}`,{headers:{'user-agent':'MediaForge-Cloudflare-Worker'}});if(!r.ok)throw new Error(`Catálogo GitHub indisponível (${r.status}).`);return r.json();}
function resolveTracks(catalog,ids){const map=new Map((catalog.tracks||[]).map(t=>[String(t.id),t]));const tracks=ids.map(id=>map.get(String(id))).filter(Boolean);return {tracks,map};}
function trackManifest(tracks){return tracks.map(t=>({id:String(t.id),title:String(t.title||'Faixa'),url:String(t.url||''),duration_seconds:Number(t.duration_seconds||0),collection_name:t.collection_name||'',style:t.style||''})).filter(t=>t.url);}

const OVH_SLOTS=['kick','twitch','youtube-deep-house','youtube-rainy'];
const OVH_DEPLOY_TARGETS=['ovh-agent','control-api','kick','twitch','youtube-deep-house','youtube-rainy'];
const OVH_DEPLOY_ACTIONS=['deploy_service','deploy_all','deploy_host_agent','health_check','rollback_service'];
function ovhAgentAllowed(request,env){
  const ip=request.headers.get('cf-connecting-ip')||'';
  const allowed=String(env.OVH_AGENT_IPS||'146.59.156.224,2001:41d0:305:2100::1:7dfb').split(',').map(x=>x.trim()).filter(Boolean);
  return {ok:allowed.includes(ip),ip};
}

function mapPlatformFromSlot(slot){return String(slot||'').startsWith('youtube-')?'youtube':String(slot||'');}
async function getYoutubeStations(env){return (await fetchGithubJson(env,'control/youtube-stations.json'))||{stations:[]};}
async function getMusicLibrary(env){return (await fetchGithubJson(env,'control/music-library.json'))||{version:1,playlists:[]};}
async function getPeterLofiSeriesConfig(env){return (await fetchGithubJson(env,'config/peter_lofi_series.json'))||{series:[]};}
async function syncMusicGenerationJob(env,row){
  if(!row)return null;
  if(['completed','failed'].includes(String(row.status||'')))return row;
  const remote=await fetchGithubJson(env,`control/generated-playlists/${row.id}.json`);
  if(!remote)return row;
  const status=String(remote.status||row.status||'queued'),progress=Math.max(0,Math.min(100,Number(remote.progress??row.progress??0))),phase=String(remote.phase||row.phase||''),err=String(remote.error_message||remote.error||'');
  await env.DB.prepare(`UPDATE music_generation_jobs SET status=?,progress=?,phase=?,github_run_id=?,github_run_url=?,release_tag=?,master_audio_url=?,error=?,updated_at=?,completed_at=?,result_json=? WHERE id=?`).bind(
    status,progress,phase,remote.github_run_id?String(remote.github_run_id):row.github_run_id||null,remote.github_run_url||row.github_run_url||null,remote.release_tag||row.release_tag||null,remote.master_audio_url||row.master_audio_url||null,err||null,new Date().toISOString(),remote.completed_at||row.completed_at||null,JSON.stringify(remote),row.id
  ).run();
  return {...row,...remote,status,progress,phase,error:err||null,result_json:JSON.stringify(remote)};
}
async function issueOvhCommand(env,command){
  const now=new Date().toISOString(),id=String(command.id||crypto.randomUUID()),path=`control/ovh-commands/${id}.json`;
  const payload={...command,id,runtime:'ovh',requested_at:command.requested_at||now};
  await env.DB.prepare(`INSERT OR REPLACE INTO ovh_commands(id,runtime_slot,action,payload_json,status,created_at,claimed_at,completed_at,error) VALUES(?,?,?,?, 'pending', ?,NULL,NULL,NULL)`).bind(id,String(payload.runtime_slot||''),String(payload.action||''),JSON.stringify(payload),now).run();
  try{
    await githubQueueFile(env,path,payload,`mediaforge ovh command ${id}`);
    const idx=(await fetchGithubJson(env,'control/ovh-commands/index.json'))||{version:1,commands:[]};
    const commands=[...(idx.commands||[]).filter(x=>String(x.id)!==id),{id,path,created_at:now}].slice(-500);
    await githubQueueFile(env,'control/ovh-commands/index.json',{version:1,updated_at:now,commands},'mediaforge ovh command index');
  }catch(_){}
  return payload;
}
async function runtimeForSession(env,id){
  try{return await env.DB.prepare(`SELECT * FROM live_runtime WHERE session_id=?`).bind(id).first();}catch(_){return null;}
}
async function ovhState(env){
  try{const row=await env.DB.prepare(`SELECT payload_json,updated_at FROM ovh_state WHERE id='ovh-main'`).first();return row?{...JSON.parse(row.payload_json||'{}'),stored_at:row.updated_at}:null;}catch(_){return null;}
}

async function syncSessionFromGitHub(env,row){
  const rt=await runtimeForSession(env,row.id);
  if(rt?.runtime==='ovh')return {...row,runtime:'ovh',runtime_slot:rt.runtime_slot||null};
  if(!['queued','starting','live','reconnecting','stopping'].includes(String(row.status)))return row;
  const p=String(row.platform)==='youtube'?`control/live-results/${row.id}.json`:String(row.platform)==='twitch'?`control/twitch-live-results/${row.id}.json`:`control/kick-live-results/${row.id}.json`;
  const remote=await fetchGithubJson(env,p);if(!remote)return row;
  const status=String(remote.status||row.status),completed=remote.completed_at||remote.ended_at||null;
  await env.DB.prepare(`UPDATE live_sessions SET status=?,github_run_id=?,github_run_url=?,error_message=?,live_at=?,completed_at=? WHERE id=?`).bind(status,remote.github_run_id||remote.run_id||null,remote.github_run_url||null,remote.error_message||null,remote.live_at||remote.started_at||null,completed,row.id).run();
  return {...row,...remote,status,completed_at:completed||row.completed_at};
}
function safeName(name){return String(name||'asset').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(-140)||'asset';}
function assetPublicUrl(request,asset){return `${new URL(request.url).origin}/media/${asset.id}/${asset.download_token}`;}
async function readAsset(env,id){return env.DB.prepare(`SELECT * FROM assets WHERE id=?`).bind(id).first();}
async function assetSummary(request,env,id){if(!id)return null;const a=await readAsset(env,id);return a?{id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,public_url:assetPublicUrl(request,a)}:null;}

async function handleMedia(request,env,url){const parts=url.pathname.split('/').filter(Boolean),id=parts[1]||'',token=parts[2]||'',asset=await env.DB.prepare(`SELECT * FROM assets WHERE id=? AND download_token=? AND status='ready'`).bind(id,token).first();if(!asset)return new Response('Not found',{status:404});const object=await env.MEDIA.get(asset.r2_key);if(!object)return new Response('Not found',{status:404});const headers=new Headers();if(object.writeHttpMetadata)object.writeHttpMetadata(headers);headers.set('etag',object.httpEtag||object.etag||'');headers.set('cache-control','public, max-age=3600');headers.set('accept-ranges','bytes');return new Response(object.body,{headers});}

async function handleApi(request,env,url){
  const cors=corsHeaders(request,env);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(url.pathname==='/api/health')return json({ok:true,service:'mediaforge-api',storage:'r2',database:'d1',supabase:false,youtube:true,kick:true,twitch:true,ovh:true},200,cors);

  if(url.pathname==='/api/ovh/agent/status'&&request.method==='POST'){
    const ip=request.headers.get('cf-connecting-ip')||'';
    const allowed=String(env.OVH_AGENT_IPS||'146.59.156.224,2001:41d0:305:2100::1:7dfb').split(',').map(x=>x.trim()).filter(Boolean);
    if(!allowed.includes(ip))return json({error:'forbidden_agent',ip},403,cors);
    const b=await bodyJson(request),now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO ovh_state(id,payload_json,updated_at) VALUES('ovh-main',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).bind(JSON.stringify(b),now).run();
    for(const [slot,s] of Object.entries(b.services||{})){
      if(!OVH_SLOTS.includes(slot))continue;
      const id=String(s?.session_id||'');if(!id)continue;
      const platform=mapPlatformFromSlot(slot),title=String(s?.title||`Peter Lofi ${platform}`),status=String(s?.status||'unknown');
      const found=await env.DB.prepare(`SELECT id FROM live_sessions WHERE id=?`).bind(id).first();
      if(!found)await env.DB.prepare(`INSERT INTO live_sessions(id,platform,status,title,description,duration_minutes,track_ids_json,created_at,live_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,platform,status,title,'',0,'[]',now,status==='live'?now:null).run();
      else await env.DB.prepare(`UPDATE live_sessions SET status=?,live_at=COALESCE(live_at,?) WHERE id=?`).bind(status,status==='live'?now:null,id).run();
      await env.DB.prepare(`INSERT INTO live_runtime(session_id,runtime,runtime_slot,last_status_at,agent_status_json) VALUES(?,'ovh',?,?,?) ON CONFLICT(session_id) DO UPDATE SET runtime='ovh',runtime_slot=excluded.runtime_slot,last_status_at=excluded.last_status_at,agent_status_json=excluded.agent_status_json`).bind(id,slot,now,JSON.stringify(s||{})).run();
    }
    return json({ok:true,stored_at:now},200,cors);
  }

  if(url.pathname==='/api/ovh/agent/commands'&&request.method==='GET'){
    const ip=request.headers.get('cf-connecting-ip')||'';
    const allowed=String(env.OVH_AGENT_IPS||'146.59.156.224,2001:41d0:305:2100::1:7dfb').split(',').map(x=>x.trim()).filter(Boolean);
    if(!allowed.includes(ip))return json({error:'forbidden_agent',ip},403,cors);
    const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit')||20)));
    const q=await env.DB.prepare(`SELECT id,payload_json,created_at FROM ovh_commands WHERE status='pending' OR (status='claimed' AND datetime(claimed_at)<datetime('now','-60 seconds')) ORDER BY created_at ASC LIMIT ?`).bind(limit).all();
    const commands=(q.results||[]).map(r=>{try{return JSON.parse(r.payload_json)}catch(_){return null}}).filter(Boolean);
    if(commands.length){
      const now=new Date().toISOString();
      for(const cmd of commands)await env.DB.prepare(`UPDATE ovh_commands SET status='claimed',claimed_at=? WHERE id=? AND status='pending'`).bind(now,String(cmd.id)).run();
    }
    return json({commands},200,cors);
  }
  if(url.pathname==='/api/ovh/agent/command-ack'&&request.method==='POST'){
    const ip=request.headers.get('cf-connecting-ip')||'';
    const allowed=String(env.OVH_AGENT_IPS||'146.59.156.224,2001:41d0:305:2100::1:7dfb').split(',').map(x=>x.trim()).filter(Boolean);
    if(!allowed.includes(ip))return json({error:'forbidden_agent',ip},403,cors);
    const b=await bodyJson(request),id=String(b.id||''),status=String(b.status||'completed'),now=new Date().toISOString();
    if(!id)return json({error:'id_required'},400,cors);
    await env.DB.prepare(`UPDATE ovh_commands SET status=?,completed_at=?,error=? WHERE id=?`).bind(status,now,String(b.error||''),id).run();
    return json({ok:true,id,status},200,cors);
  }

  if(url.pathname==='/api/ovh/deploy-agent/commands'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_deploy_agent',ip:gate.ip},403,cors);
    const limit=Math.max(1,Math.min(20,Number(url.searchParams.get('limit')||5)));
    const q=await env.DB.prepare(`SELECT id,payload_json,created_at FROM ovh_deploy_commands WHERE status='pending' OR (status='claimed' AND datetime(claimed_at)<datetime('now','-120 seconds')) ORDER BY created_at ASC LIMIT ?`).bind(limit).all();
    const commands=(q.results||[]).map(r=>{try{return JSON.parse(r.payload_json)}catch(_){return null}}).filter(Boolean);
    if(commands.length){
      const now=new Date().toISOString();
      for(const cmd of commands)await env.DB.prepare(`UPDATE ovh_deploy_commands SET status='claimed',claimed_at=? WHERE id=?`).bind(now,String(cmd.id)).run();
    }
    return json({commands},200,cors);
  }
  if(url.pathname==='/api/ovh/deploy-agent/ack'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_deploy_agent',ip:gate.ip},403,cors);
    const b=await bodyJson(request),id=String(b.id||''),status=String(b.status||'completed'),now=new Date().toISOString();
    if(!id)return json({error:'id_required'},400,cors);
    if(!['completed','failed'].includes(status))return json({error:'invalid_status'},400,cors);
    const result=b.result&&typeof b.result==='object'?b.result:{};
    await env.DB.prepare(`UPDATE ovh_deploy_commands SET status=?,completed_at=?,error=?,result_json=? WHERE id=?`).bind(status,now,String(b.error||''),JSON.stringify(result),id).run();
    return json({ok:true,id,status},200,cors);
  }

  if(url.pathname==='/api/auth/login'&&request.method==='POST'){const b=await bodyJson(request),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!env.ADMIN_EMAIL||!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return json({error:'auth_not_configured'},503,cors);if(email!==String(env.ADMIN_EMAIL).trim().toLowerCase()||password!==String(env.ADMIN_PASSWORD))return json({error:'invalid_credentials',message:'E-mail ou senha inválidos.'},401,cors);return json({ok:true,token:await signSession(email,env.SESSION_SECRET),user:{email,role:'admin'}},200,cors);}
  const session=await requireAuth(request,env);if(!session)return json({error:'unauthorized',message:'Sessão inválida ou expirada.'},401,cors);
  if(url.pathname==='/api/me'&&request.method==='GET')return json({user:{email:session.sub,role:'admin'}},200,cors);
  if(url.pathname==='/api/music/presets'&&request.method==='GET'){
    const cfg=await getPeterLofiSeriesConfig(env);
    const presets=(cfg.series||[]).map(s=>({index:s.index,key:s.key,name:s.name,playlist:s.playlist||s.name,description:s.description||'',genre:(s.music_dna?.style_pool||[])[0]||'Lofi',moods:s.music_dna?.mood||[]}));
    return json({presets},200,cors);
  }

  if(url.pathname==='/api/music/generate'&&request.method==='POST'){
    try{
      const b=await bodyJson(request),seriesKey=String(b.series_key||'').trim(),playlistName=String(b.playlist_name||'').trim();
      const duration=Math.max(30,Math.min(180,Number(b.duration_minutes||60)));
      const cfg=await getPeterLofiSeriesConfig(env),preset=(cfg.series||[]).find(s=>String(s.key)===seriesKey);
      if(!preset)return json({error:'invalid_series_key',message:'Selecione um preset musical válido.'},400,cors);
      const id=crypto.randomUUID(),now=new Date().toISOString(),name=(playlistName||preset.name||seriesKey).slice(0,80);
      await env.DB.prepare(`INSERT INTO music_generation_jobs(id,series_key,playlist_name,duration_minutes,status,progress,phase,created_at,updated_at) VALUES(?,?,?,?, 'queued',0,'Na fila',?,?)`).bind(id,seriesKey,name,duration,now,now).run();
      await githubDispatchWorkflow(env,'peter-lofi-generate-playlist.yml',{request_id:id,series_key:seriesKey,playlist_name:name,duration_minutes:String(duration)});
      return json({ok:true,job:{id,series_key:seriesKey,playlist_name:name,duration_minutes:duration,status:'queued',progress:0,phase:'Na fila',created_at:now}},200,cors);
    }catch(e){return json({error:'music_generate_failed',message:e.message},502,cors);}
  }

  if(url.pathname==='/api/music/jobs'&&request.method==='GET'){
    const q=await env.DB.prepare(`SELECT * FROM music_generation_jobs ORDER BY created_at DESC LIMIT 30`).all();
    const rows=[];
    for(const raw of q.results||[]){
      const row=await syncMusicGenerationJob(env,raw);
      let result=null;try{result=row?.result_json?JSON.parse(row.result_json):null}catch(_){}
      rows.push({...row,result});
    }
    return json({jobs:rows},200,cors);
  }

  const musicJobMatch=url.pathname.match(/^\/api\/music\/jobs\/([^/]+)$/);
  if(musicJobMatch&&request.method==='GET'){
    let row=await env.DB.prepare(`SELECT * FROM music_generation_jobs WHERE id=?`).bind(musicJobMatch[1]).first();
    if(!row)return json({error:'music_job_not_found'},404,cors);
    row=await syncMusicGenerationJob(env,row);
    let result=null;try{result=row?.result_json?JSON.parse(row.result_json):null}catch(_){}
    return json({job:{...row,result}},200,cors);
  }


  if(url.pathname==='/api/ovh/deploy'&&request.method==='POST'){
    const b=await bodyJson(request),action=String(b.action||''),requested=String(b.request_id||'').trim();let target=String(b.target||'');
    if(!OVH_DEPLOY_ACTIONS.includes(action))return json({error:'invalid_deploy_action'},400,cors);
    if(['deploy_service','rollback_service'].includes(action)&&!OVH_DEPLOY_TARGETS.includes(target))return json({error:'invalid_deploy_target'},400,cors);
    if(action==='deploy_all')target='all';
    if(action==='deploy_host_agent')target='host-agent';
    if(action==='health_check')target=target&&OVH_DEPLOY_TARGETS.includes(target)?target:'all';
    const id=/^[A-Za-z0-9._:-]{8,128}$/.test(requested)?requested:crypto.randomUUID(),now=new Date().toISOString();
    const existing=await env.DB.prepare(`SELECT id,action,target,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands WHERE id=?`).bind(id).first();
    if(existing)return json({ok:true,command:{...existing,result:existing.result_json?JSON.parse(existing.result_json):null},deduplicated:true},200,cors);
    const payload={id,action,target,requested_at:now,requested_by:session.sub,source:String(b.source||'mediaforge')};
    await env.DB.prepare(`INSERT INTO ovh_deploy_commands(id,action,target,payload_json,status,created_at) VALUES(?,?,?,?, 'pending', ?)`).bind(id,action,target,JSON.stringify(payload),now).run();
    return json({ok:true,command:payload,status:'pending'},200,cors);
  }

  if(url.pathname==='/api/ovh/deploy-status'&&request.method==='GET'){
    const id=String(url.searchParams.get('id')||'');
    if(id){
      const row=await env.DB.prepare(`SELECT id,action,target,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands WHERE id=?`).bind(id).first();
      if(!row)return json({error:'deploy_command_not_found'},404,cors);
      return json({command:{...row,result:row.result_json?JSON.parse(row.result_json):null}},200,cors);
    }
    const q=await env.DB.prepare(`SELECT id,action,target,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands ORDER BY created_at DESC LIMIT 25`).all();
    return json({commands:(q.results||[]).map(r=>({...r,result:r.result_json?JSON.parse(r.result_json):null}))},200,cors);
  }

  if(url.pathname==='/api/ovh/status'&&request.method==='GET'){
    const state=await ovhState(env),stations=await getYoutubeStations(env);
    let recentCommands=[];try{const q=await env.DB.prepare(`SELECT id,runtime_slot,action,status,created_at,claimed_at,completed_at,error FROM ovh_commands ORDER BY created_at DESC LIMIT 20`).all();recentCommands=q.results||[]}catch(_){}
    return json({runtime:'ovh',agent:state,youtube_slots:stations.stations||[],slots:OVH_SLOTS,recent_commands:recentCommands},200,cors);
  }
  if(url.pathname==='/api/music-library'&&request.method==='GET'){
    const library=await getMusicLibrary(env);
    return json(library,200,cors);
  }
  if(url.pathname==='/api/ovh/playlist'&&request.method==='POST'){
    const b=await bodyJson(request),slot=String(b.runtime_slot||''),playlistKey=String(b.playlist_key||'');
    if(!OVH_SLOTS.includes(slot))return json({error:'invalid_runtime_slot'},400,cors);
    const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)===playlistKey);
    if(!playlist)return json({error:'playlist_not_found',message:'Playlist não encontrada no catálogo Peter Lofi.'},404,cors);
    const tracks=(playlist.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({id:String(t.id||`${playlistKey}-${i+1}`),title:String(t.title||'Track'),url:String(t.url),duration_seconds:Number(t.duration_seconds||0)}));
    if(!tracks.length)return json({error:'playlist_empty'},400,cors);
    const state=await ovhState(env),svc=state?.services?.[slot]||{};
    const cmd=await issueOvhCommand(env,{action:'set_playlist',runtime_slot:slot,platform:mapPlatformFromSlot(slot),session_id:String(b.session_id||svc.session_id||''),title:String(svc.title||''),playlist_key:playlistKey,tracks,shuffle:b.shuffle!==false,repeat:true,source:'mediaforge-playlist-switch'});
    return json({ok:true,playlist:{key:playlist.key,name:playlist.name,track_count:tracks.length},command:cmd},200,cors);
  }
  if(url.pathname==='/api/ovh/control'&&request.method==='POST'){
    const b=await bodyJson(request),action=String(b.action||'').toLowerCase(),slot=String(b.runtime_slot||'');
    if(!['start','stop','restart','skip','previous'].includes(action)||!OVH_SLOTS.includes(slot))return json({error:'invalid_ovh_control'},400,cors);
    const state=await ovhState(env),svc=state?.services?.[slot]||{},sessionId=String(b.session_id||svc.session_id||'');
    if(action==='stop'&&slot.startsWith('youtube-')&&sessionId){
      await githubDispatchWorkflow(env,'mediaforge-youtube-ovh-stop.yml',{session_id:sessionId,runtime_slot:slot});
      return json({ok:true,action:'stop',runtime_slot:slot,session_id:sessionId,mode:'youtube-controlled-stop'},200,cors);
    }
    const cmd=await issueOvhCommand(env,{action,runtime_slot:slot,platform:mapPlatformFromSlot(slot),session_id:sessionId,title:String(b.title||svc.title||''),loop_url:String(b.loop_url||''),source:'mediaforge-ovh-panel'});
    return json({ok:true,command:cmd},200,cors);
  }

  if(url.pathname==='/api/ovh/visual'&&request.method==='POST'){
    const b=await bodyJson(request),slot=String(b.runtime_slot||''),assetId=String(b.asset_id||''),directUrl=String(b.loop_url||'').trim();
    if(!OVH_SLOTS.includes(slot))return json({error:'invalid_runtime_slot'},400,cors);
    let loopUrl=directUrl,asset=null;
    if(assetId){
      asset=await readAsset(env,assetId);
      if(!asset||asset.status!=='ready')return json({error:'visual_asset_not_ready'},404,cors);
      if(asset.asset_type!=='loop')return json({error:'visual_asset_invalid_type'},400,cors);
      loopUrl=assetPublicUrl(request,asset);
    }
    if(!loopUrl)return json({error:'loop_url_required',message:'Selecione ou envie um vídeo antes de aplicar.'},400,cors);
    const state=await ovhState(env),svc=state?.services?.[slot]||{},sessionId=String(b.session_id||svc.session_id||'');
    const cmd=await issueOvhCommand(env,{action:'set_visual',runtime_slot:slot,platform:mapPlatformFromSlot(slot),session_id:sessionId,title:String(svc.title||''),loop_url:loopUrl,asset_id:assetId||null,source:'mediaforge-visual-switch'});
    if(sessionId&&assetId){
      try{await env.DB.prepare(`INSERT OR REPLACE INTO live_session_assets(session_id,role,asset_id) VALUES(?,?,?)`).bind(sessionId,'visual',assetId).run();}catch(_){}
    }
    return json({ok:true,visual:{asset_id:assetId||null,title:asset?.title||null,loop_url:loopUrl},command:cmd},200,cors);
  }

  if(url.pathname==='/api/catalog'&&request.method==='GET')try{const catalog=await getCatalog(env),assets=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();return json({...catalog,assets:(assets.results||[]).map(a=>({id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,metadata:JSON.parse(a.metadata_json||'{}'),public_url:assetPublicUrl(request,a)}))},200,cors);}catch(e){return json({error:'catalog_error',message:e.message},502,cors);}
  if(url.pathname==='/api/assets'&&request.method==='GET'){const q=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();return json({assets:(q.results||[]).map(a=>({id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,metadata:JSON.parse(a.metadata_json||'{}'),public_url:assetPublicUrl(request,a)}))},200,cors);}

  if(url.pathname==='/api/uploads/init'&&request.method==='POST'){
    const b=await bodyJson(request),name=safeName(b.name),mime=String(b.mime_type||'application/octet-stream'),size=Math.max(0,Number(b.size_bytes||0)),assetId=crypto.randomUUID(),token=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),day=new Date().toISOString().slice(0,10),assetType=['thumbnail','loop'].includes(String(b.asset_type))?String(b.asset_type):'loop',key=`${assetType==='thumbnail'?'thumb':'live'}/${day}/${assetId}-${name}`,upload=await env.MEDIA.createMultipartUpload(key,{httpMetadata:{contentType:mime}}),now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(assetId,b.title||b.name||name,assetType,key,mime,size,'uploading',token,JSON.stringify({live_visual:assetType==='loop',youtube_thumbnail:assetType==='thumbnail',loop_forever:assetType==='loop',source:'r2_upload'}),now).run();
    return json({ok:true,asset_id:assetId,upload_id:upload.uploadId,chunk_size:50*1024*1024},200,cors);
  }
  if(url.pathname==='/api/uploads/part'&&request.method==='PUT'){const assetId=url.searchParams.get('asset_id')||'',uploadId=url.searchParams.get('upload_id')||'',partNumber=Number(url.searchParams.get('part_number')||0);if(!assetId||!uploadId||partNumber<1)return json({error:'bad_upload_part'},400,cors);const asset=await readAsset(env,assetId);if(!asset||asset.status!=='uploading')return json({error:'asset_not_uploading'},404,cors);const part=await env.MEDIA.resumeMultipartUpload(asset.r2_key,uploadId).uploadPart(partNumber,request.body);return json({partNumber:part.partNumber,etag:part.etag},200,cors);}
  if(url.pathname==='/api/uploads/complete'&&request.method==='POST'){const b=await bodyJson(request),asset=await readAsset(env,String(b.asset_id||''));if(!asset)return json({error:'asset_not_found'},404,cors);const parts=(b.parts||[]).map(p=>({partNumber:Number(p.partNumber),etag:String(p.etag)})).sort((a,b)=>a.partNumber-b.partNumber);if(!parts.length)return json({error:'parts_required'},400,cors);await env.MEDIA.resumeMultipartUpload(asset.r2_key,String(b.upload_id||'')).complete(parts);await env.DB.prepare(`UPDATE assets SET status='ready' WHERE id=?`).bind(asset.id).run();const ready=await readAsset(env,asset.id);return json({ok:true,asset:{id:ready.id,title:ready.title,asset_type:ready.asset_type,mime_type:ready.mime_type,size_bytes:ready.size_bytes,created_at:ready.created_at,metadata:JSON.parse(ready.metadata_json||'{}'),public_url:assetPublicUrl(request,ready)}},200,cors);}
  if(url.pathname==='/api/uploads/abort'&&request.method==='POST'){const b=await bodyJson(request),asset=await readAsset(env,String(b.asset_id||''));if(!asset)return json({error:'asset_not_found'},404,cors);try{await env.MEDIA.resumeMultipartUpload(asset.r2_key,String(b.upload_id||'')).abort();}catch(_){}await env.DB.prepare(`UPDATE assets SET status='aborted' WHERE id=?`).bind(asset.id).run();return json({ok:true},200,cors);}

  if(url.pathname==='/api/live/start'&&request.method==='POST'){
    try{
      const b=await bodyJson(request),platform=String(b.platform||'kick').toLowerCase();
      if(!['kick','twitch','youtube'].includes(platform))return json({error:'unsupported_platform'},400,cors);
      const playlistKey=String(b.playlist_key||''),trackIds=Array.isArray(b.track_ids)?b.track_ids.map(String):[];
      let manifest=[];
      if(playlistKey){
        const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)===playlistKey);
        if(!playlist)return json({error:'playlist_not_found',message:'Playlist não encontrada na biblioteca Peter Lofi.'},404,cors);
        manifest=(playlist.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({id:String(t.id||`${playlistKey}-${i+1}`),title:String(t.title||'Track'),url:String(t.url),duration_seconds:Number(t.duration_seconds||0)}));
        if(!manifest.length)return json({error:'playlist_empty'},400,cors);
      }else{
        const catalog=await getCatalog(env);
        if(!trackIds.length)return json({error:'select_at_least_one_track'},400,cors);
        const resolved=resolveTracks(catalog,trackIds),tracks=resolved.tracks;
        if(tracks.length!==trackIds.length)return json({error:'invalid_track_selection',message:'Uma ou mais músicas não existem no catálogo GitHub.'},400,cors);
        manifest=trackManifest(tracks);if(manifest.length!==trackIds.length)return json({error:'no_playable_tracks'},400,cors);
      }
      const visualId=b.visual_asset_id?String(b.visual_asset_id):'',thumbId=b.thumbnail_asset_id?String(b.thumbnail_asset_id):'';let visualUrl='',thumbnailUrl='';
      if(visualId){const a=await readAsset(env,visualId);if(!a||a.status!=='ready')return json({error:'visual_not_ready'},400,cors);visualUrl=assetPublicUrl(request,a);}
      if(thumbId){const a=await readAsset(env,thumbId);if(!a||a.status!=='ready'||!String(a.mime_type||'').startsWith('image/'))return json({error:'thumbnail_not_ready',message:'A thumbnail do YouTube precisa ser uma imagem pronta.'},400,cors);thumbnailUrl=assetPublicUrl(request,a);}
      const id=crypto.randomUUID(),title=String(b.title||'Peter Lofi — Live').trim()||'Peter Lofi — Live',description=String(b.description||''),duration=Math.max(0,Math.min(10080,Number(b.duration_minutes??0)||0)),now=new Date().toISOString();
      let slot=platform;
      if(platform==='youtube'){
        slot=String(b.youtube_slot||'');
        if(!['youtube-deep-house','youtube-rainy'].includes(slot))return json({error:'youtube_slot_required',message:'Selecione um slot OVH do YouTube.'},400,cors);
        const cfg=await getYoutubeStations(env),st=(cfg.stations||[]).find(x=>String(x.ovh_slot||'')===slot);
        if(!st||!st.youtube_stream_id)return json({error:'youtube_slot_not_configured'},409,cors);
        if(st.current_session_id&&String(st.status||'')==='live')return json({error:'youtube_slot_busy',message:`O slot ${st.name||slot} já está transmitindo. Encerre essa live antes de reutilizar o slot.`},409,cors);
      }
      await env.DB.prepare(`INSERT INTO live_sessions(id,platform,status,title,description,duration_minutes,track_ids_json,visual_asset_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,platform,'starting',title,description,duration,JSON.stringify(trackIds),visualId||null,now).run();
      await env.DB.prepare(`INSERT INTO live_runtime(session_id,runtime,runtime_slot,last_status_at,agent_status_json) VALUES(?,'ovh',?,?,?)`).bind(id,slot,now,'{}').run();
      if(visualId)await env.DB.prepare(`INSERT OR REPLACE INTO live_session_assets(session_id,role,asset_id) VALUES(?,?,?)`).bind(id,'visual',visualId).run();
      if(thumbId)await env.DB.prepare(`INSERT OR REPLACE INTO live_session_assets(session_id,role,asset_id) VALUES(?,?,?)`).bind(id,'thumbnail',thumbId).run();
      await githubQueueFile(env,`control/live-playlists/${id}.json`,{session_id:id,platform,runtime:'ovh',runtime_slot:slot,playlist_key:playlistKey||null,updated_at:now,tracks:manifest},`mediaforge ovh playlist ${id}`);
      const common={session_id:id,platform,runtime_slot:slot,title,description,duration_minutes:duration,loop_url:visualUrl,playlist_key:playlistKey||null,tracks:manifest,shuffle:true,repeat:true,requested_at:now,source:'mediaforge'};
      if(platform==='youtube'){
        await githubQueueFile(env,`control/youtube-ovh-queue/${id}.json`,{...common,thumbnail_url:thumbnailUrl},`mediaforge youtube ovh queue ${id}`);
        await githubDispatchWorkflow(env,'mediaforge-youtube-ovh-prepare.yml',{session_id:id,runtime_slot:slot,title,description,thumbnail_url:thumbnailUrl,duration_minutes:String(duration)});
        return json({ok:true,launch_mode:'ovh-youtube-prepare',session:{id,platform,status:'starting',runtime:'ovh',runtime_slot:slot,title,description,duration_minutes:duration,track_ids:trackIds,created_at:now}},200,cors);
      }
      const cmd=await issueOvhCommand(env,{...common,action:'start'});
      return json({ok:true,launch_mode:'ovh-direct',command_id:cmd.id,session:{id,platform,status:'starting',runtime:'ovh',runtime_slot:slot,title,description,duration_minutes:duration,track_ids:trackIds,created_at:now}},200,cors);
    }catch(e){return json({error:'start_live_failed',message:e.message},502,cors);}
  }

  const stopMatch=url.pathname.match(/^\/api\/live\/([^/]+)\/stop$/);
  if(stopMatch&&request.method==='POST'){
    const id=stopMatch[1],row=await env.DB.prepare(`SELECT * FROM live_sessions WHERE id=?`).bind(id).first();if(!row)return json({error:'session_not_found'},404,cors);
    try{
      const rt=await runtimeForSession(env,id),slot=rt?.runtime_slot||String(row.platform);
      if(String(row.platform)==='youtube'){
        await githubDispatchWorkflow(env,'mediaforge-youtube-ovh-stop.yml',{session_id:id,runtime_slot:String(slot||'')});
      }else{
        await issueOvhCommand(env,{action:'stop',platform:row.platform,runtime_slot:slot,session_id:id,title:row.title,source:'mediaforge'});
      }
      await env.DB.prepare(`UPDATE live_sessions SET status='stopping' WHERE id=?`).bind(id).run();
      return json({ok:true,session_id:id,status:'stopping',runtime:'ovh',runtime_slot:slot},200,cors);
    }catch(e){return json({error:'stop_live_failed',message:e.message},502,cors);}
  }

  const tracksMatch=url.pathname.match(/^\/api\/live\/([^/]+)\/tracks$/);
  if(tracksMatch&&request.method==='PATCH'){
    const id=tracksMatch[1],row=await env.DB.prepare(`SELECT * FROM live_sessions WHERE id=?`).bind(id).first();if(!row)return json({error:'session_not_found'},404,cors);
    const b=await bodyJson(request),ids=Array.isArray(b.track_ids)?b.track_ids.map(String):[];if(!ids.length)return json({error:'select_at_least_one_track',message:'A live precisa manter pelo menos uma música.'},400,cors);
    const catalog=await getCatalog(env),{tracks}=resolveTracks(catalog,ids);if(tracks.length!==ids.length)return json({error:'invalid_track_selection'},400,cors);const manifest=trackManifest(tracks),now=new Date().toISOString();
    await env.DB.prepare(`UPDATE live_sessions SET track_ids_json=? WHERE id=?`).bind(JSON.stringify(ids),id).run();
    const rt=await runtimeForSession(env,id),slot=rt?.runtime_slot||String(row.platform);
    await githubQueueFile(env,`control/live-playlists/${id}.json`,{session_id:id,platform:row.platform,runtime:'ovh',runtime_slot:slot,updated_at:now,tracks:manifest},`mediaforge: update live playlist ${id}`);
    if(rt?.runtime==='ovh')await issueOvhCommand(env,{action:'update_playlist',platform:row.platform,runtime_slot:slot,session_id:id,title:row.title,tracks:manifest,source:'mediaforge'});
    return json({ok:true,session_id:id,track_ids:ids,tracks:manifest,applies_after_current_track:true,runtime:rt?.runtime||'legacy'},200,cors);
  }

  const detailMatch=url.pathname.match(/^\/api\/live\/([^/]+)$/);
  if(detailMatch&&request.method==='GET'){
    let row=await env.DB.prepare(`SELECT * FROM live_sessions WHERE id=?`).bind(detailMatch[1]).first();if(!row)return json({error:'session_not_found'},404,cors);
    row=await syncSessionFromGitHub(env,row);
    const rt=await runtimeForSession(env,row.id),ids=JSON.parse(row.track_ids_json||'[]'),catalog=await getCatalog(env),{tracks}=resolveTracks(catalog,ids),analytics=await fetchGithubJson(env,'control/live-analytics.json'),assetRows=await env.DB.prepare(`SELECT role,asset_id FROM live_session_assets WHERE session_id=?`).bind(row.id).all(),assetMap={};
    for(const a of assetRows.results||[])assetMap[a.role]=await assetSummary(request,env,a.asset_id);
    const state=await ovhState(env),slot=rt?.runtime_slot||null,svc=slot?state?.services?.[slot]:null;
    let external=null;if(String(row.platform)==='kick')external=analytics?.kick||null;else if(String(row.platform)==='youtube')external=(analytics?.youtube?.sessions||[]).find(x=>x.session_id===row.id)||null;
    return json({session:{...row,track_ids:ids,runtime:rt?.runtime||null,runtime_slot:slot},tracks:trackManifest(tracks),now_playing:svc?.now_playing||null,ovh_service:svc||null,analytics:external,analytics_generated_at:analytics?.generated_at||null,assets:assetMap},200,cors);
  }

  if(url.pathname==='/api/live-sessions'&&request.method==='GET'){
    const q=await env.DB.prepare(`SELECT * FROM live_sessions ORDER BY created_at DESC LIMIT 75`).all(),rows=[];
    for(const r of q.results||[]){const x=await syncSessionFromGitHub(env,r),rt=await runtimeForSession(env,r.id);rows.push({...x,runtime:rt?.runtime||null,runtime_slot:rt?.runtime_slot||null,track_ids:JSON.parse(r.track_ids_json||'[]')});}
    return json({sessions:rows},200,cors);
  }
  if(url.pathname==='/api/live-sessions'&&request.method==='DELETE'){const b=await bodyJson(request),active=await env.DB.prepare(`SELECT COUNT(*) AS n FROM live_sessions WHERE status IN ('queued','starting','live','reconnecting','stopping')`).first(),count=Number(active?.n||0);if(count&&!b.force)return json({error:'active_sessions',active_count:count,message:'Existem lives ativas ou na fila.'},409,cors);const all=await env.DB.prepare(`SELECT COUNT(*) AS n FROM live_sessions`).first();await env.DB.prepare(`DELETE FROM live_session_assets`).run();await env.DB.prepare(`DELETE FROM live_sessions`).run();return json({ok:true,deleted:Number(all?.n||0)},200,cors);}

  return json({error:'not_found'},404,cors);
}

export default{async fetch(request,env){const url=new URL(request.url);try{if(url.pathname.startsWith('/media/'))return handleMedia(request,env,url);if(url.pathname.startsWith('/api/'))return handleApi(request,env,url);return json({service:'MediaForge API',backend:'Cloudflare Worker + D1 + R2 + OVH control',supabase:false,ovh:true});}catch(e){return json({error:'internal_error',message:e?.message||String(e)},500,corsHeaders(request,env));}}};
