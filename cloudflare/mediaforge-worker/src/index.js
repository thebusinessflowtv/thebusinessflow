import { appendGamingDj30Assets } from './gaming-dj30-library.js';
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
function corsHeaders(request,env){const origin=request.headers.get('origin')||'',allowed=env.FRONTEND_ORIGIN||'https://thebusinessflowtv.github.io',twitchOrigin=origin==='https://www.twitch.tv'||origin==='https://twitch.tv'||origin==='https://dashboard.twitch.tv',allowOrigin=origin&&(origin===allowed||origin.startsWith(allowed+':')||twitchOrigin)?origin:allowed;return {'access-control-allow-origin':allowOrigin,'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','access-control-allow-headers':'authorization,content-type,x-upload-name,x-upload-type','access-control-max-age':'86400','vary':'Origin'};}
async function bodyJson(request){try{return await request.json();}catch(_){return {};}}
function bearer(request){const h=request.headers.get('authorization')||'';return h.toLowerCase().startsWith('bearer ')?h.slice(7).trim():'';}
async function requireAuth(request,env){const t=bearer(request);return t?verifySession(t,env.SESSION_SECRET||''):null;}
function b64urlBytesRaw(s){
  const p=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=p+'='.repeat((4-p.length%4)%4);
  return Uint8Array.from(atob(padded),ch=>ch.charCodeAt(0));
}
function b64urlJsonRaw(s){
  return JSON.parse(new TextDecoder().decode(b64urlBytesRaw(s)));
}
async function verifyGithubActionsOidc(token){
  const parts=String(token||'').split('.');
  if(parts.length!==3)throw new Error('invalid_oidc_token');
  const [h,p,s]=parts,header=b64urlJsonRaw(h),claims=b64urlJsonRaw(p);
  if(header.alg!=='RS256'||!header.kid)throw new Error('invalid_oidc_header');
  const now=Math.floor(Date.now()/1000),aud=claims.aud;
  const audOk=Array.isArray(aud)?aud.includes('mediaforge-ovh'):String(aud||'')==='mediaforge-ovh';
  if(claims.iss!=='https://token.actions.githubusercontent.com'||!audOk)throw new Error('invalid_oidc_issuer_or_audience');
  if(Number(claims.exp||0)<now-30||Number(claims.nbf||0)>now+30)throw new Error('expired_or_early_oidc_token');
  if(String(claims.repository||'')!=='thebusinessflowtv/theofficemusic')throw new Error('invalid_oidc_repository');
  if(String(claims.ref||'')!=='refs/heads/main')throw new Error('invalid_oidc_ref');
  const workflowRef=String(claims.workflow_ref||'');
  const allowedWorkflowRefs=[
    'thebusinessflowtv/theofficemusic/.github/workflows/gta-youtube-oauth-bridge.yml@refs/heads/main',
    'thebusinessflowtv/theofficemusic/.github/workflows/ops-gta-oidc-preflight.yml@refs/heads/main'
  ];
  if(!allowedWorkflowRefs.some(x=>workflowRef.includes(x)))throw new Error('invalid_oidc_workflow');

  const jwksRes=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks');
  if(!jwksRes.ok)throw new Error('github_oidc_jwks_unavailable');
  const jwks=await jwksRes.json();
  const jwk=(jwks.keys||[]).find(k=>k.kid===header.kid);
  if(!jwk)throw new Error('github_oidc_key_not_found');
  if(jwk.kty!=='RSA'||!jwk.n||!jwk.e)throw new Error('github_oidc_key_invalid');
  const verifyJwk={kty:'RSA',n:String(jwk.n),e:String(jwk.e),alg:'RS256',ext:true};
  let key;
  try{
    key=await crypto.subtle.importKey('jwk',verifyJwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  }catch(e){
    throw new Error('github_oidc_key_import_failed:'+String(e?.message||e));
  }
  let ok=false;
  try{
    ok=await crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5'},key,b64urlBytesRaw(s),enc.encode(h+'.'+p));
  }catch(e){
    throw new Error('github_oidc_verify_failed:'+String(e?.message||e));
  }
  if(!ok)throw new Error('invalid_oidc_signature');
  return claims;
}


function githubHeaders(env){return {'authorization':`Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'MediaForge-Cloudflare-Worker','content-type':'application/json'};}
async function githubQueueFile(env,path,payload,message){
  if(String(env.LOCAL_RUNTIME||'')==='1'){
    await setLocalConfig(env,path,payload);
    return {local:true,path};
  }
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no Worker.');
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic',api=`https://api.github.com/repos/${repo}/contents/${path}`;
  let sha='';
  try{const g=await fetch(api+'?ref=main',{headers:githubHeaders(env)});if(g.ok)sha=String((await g.json()).sha||'');}catch(_){}
  const body={message:message||`mediaforge: update ${path}`,content:base64Utf8(JSON.stringify(payload,null,2)),branch:'main'};if(sha)body.sha=sha;
  const res=await fetch(api,{method:'PUT',headers:githubHeaders(env),body:JSON.stringify(body)});
  if(!res.ok){const text=await res.text();throw new Error(`GitHub queue falhou (${res.status}): ${text.slice(0,500)}`);}return res.json();
}
async function githubQueueFileToRepo(env,repo,path,payload,message){
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('Bridge GitHub indisponível: token não configurado no bridge remoto.');
  const api=`https://api.github.com/repos/${repo}/contents/${path}`;
  let sha='';
  try{const g=await fetch(api+'?ref=main',{headers:githubHeaders(env)});if(g.ok)sha=String((await g.json()).sha||'');}catch(_){}
  const body={message:message||`mediaforge: update ${path}`,content:base64Utf8(JSON.stringify(payload,null,2)),branch:'main'};if(sha)body.sha=sha;
  const res=await fetch(api,{method:'PUT',headers:githubHeaders(env),body:JSON.stringify(body)});
  if(!res.ok){const text=await res.text();throw new Error(`Bridge GitHub falhou (${res.status}): ${text.slice(0,500)}`);}
  return res.json();
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
  const cached=await localConfigJson(env,path);
  if(cached!==null)return cached;
  if(String(env.LOCAL_RUNTIME||'')==='1')return null;
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic';
  try{const r=await fetch(`https://raw.githubusercontent.com/${repo}/main/${path}?ts=${Date.now()}`,{headers:{'user-agent':'MediaForge-Cloudflare-Worker'}});return r.ok?await r.json():null;}catch(_){return null;}
}
async function getCatalog(env){
  const cached=await localConfigJson(env,'control/mediaforge-catalog.json');
  if(cached!==null)return cached;
  if(String(env.LOCAL_RUNTIME||'')==='1')throw new Error('Catálogo local da OVH ainda não foi sincronizado.');
  const repo=env.GITHUB_REPO||'thebusinessflowtv/theofficemusic',r=await fetch(`https://raw.githubusercontent.com/${repo}/main/control/mediaforge-catalog.json?ts=${Date.now()}`,{headers:{'user-agent':'MediaForge-Cloudflare-Worker'}});
  if(!r.ok)throw new Error(`Catálogo GitHub indisponível (${r.status}).`);
  return r.json();
}
function resolveTracks(catalog,ids){const map=new Map((catalog.tracks||[]).map(t=>[String(t.id),t]));const tracks=ids.map(id=>map.get(String(id))).filter(Boolean);return {tracks,map};}
function trackManifest(tracks){return tracks.map(t=>({id:String(t.id),title:String(t.title||'Faixa'),url:String(t.url||''),duration_seconds:Number(t.duration_seconds||0),collection_name:t.collection_name||'',style:t.style||''})).filter(t=>t.url);}


/* VIDEO_FACTORY_CHANNELS_V2
   Video production control-plane lives in MediaForge DB + GitHub.
   It is intentionally isolated from all live-stream tables/endpoints. */
const VIDEO_FACTORY_CHANNELS_V2=[
  {id:'the-business-flow',slug:'the-business-flow',name:'The Business Flow',repo:'thebusinessflowtv/thebusinessflow',niche:'Business / Companies / Technology / Money',locale:'en-US',youtube_connected:true,allow_youtube_upload:true},
  {id:'nba-stars',slug:'nba-stars',name:'NBA Stars',repo:'thebusinessflowtv/nbastarstv',niche:'NBA / Players / Teams / Rivalries / Curiosities / Stories',locale:'en-US',youtube_connected:false,allow_youtube_upload:false}
];
function videoFactoryChannel(value){
  const v=String(value||'').trim().toLowerCase();
  return VIDEO_FACTORY_CHANNELS_V2.find(x=>x.id===v||x.slug===v||x.name.toLowerCase()===v)||null;
}
async function ensureVideoFactorySchema(env){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS video_productions (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_slug TEXT NOT NULL, channel_name TEXT NOT NULL, repo TEXT NOT NULL, requested_topic TEXT, selected_topic TEXT, generation_mode TEXT NOT NULL, objective TEXT NOT NULL, notes TEXT, upload_requested INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', progress INTEGER NOT NULL DEFAULT 0, dispatch_kind TEXT, dispatch_commit_sha TEXT, github_run_id TEXT, github_run_url TEXT, suggestions_json TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_video_productions_created ON video_productions(created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_video_productions_channel ON video_productions(channel_slug,created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_video_productions_status ON video_productions(status,created_at DESC)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS video_production_events (id TEXT PRIMARY KEY, production_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_video_events_prod ON video_production_events(production_id,created_at)").run();
}
async function videoFactoryEvent(env,productionId,stage,status,message,payload){
  await env.DB.prepare("INSERT INTO video_production_events(id,production_id,stage,status,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),String(productionId),String(stage||'system'),String(status||'info'),String(message||''),JSON.stringify(payload||{}),new Date().toISOString()).run();
}
function normalizeVideoFactoryRow(row){
  if(!row)return null;
  let suggestions=null;
  try{suggestions=row.suggestions_json?JSON.parse(row.suggestions_json):null}catch(_){}
  return {...row,upload_requested:!!Number(row.upload_requested||0),suggestions};
}
async function githubRepoJson(env,repo,path){
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no MediaForge.');
  const api='https://api.github.com/repos/'+repo+'/contents/'+path+'?ref=main';
  const r=await fetch(api,{headers:githubHeaders(env)});
  if(r.status===404)return null;
  if(!r.ok)throw new Error('GitHub leitura falhou ('+r.status+'): '+(await r.text()).slice(0,400));
  const d=await r.json();
  if(!d||!d.content)return null;
  const raw=String(d.content).replace(/\s+/g,'');
  const bytes=Uint8Array.from(atob(raw),ch=>ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function githubWorkflowRunsForRepo(env,repo,workflow){
  if(!env.GITHUB_WORKFLOW_TOKEN)throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no MediaForge.');
  const api='https://api.github.com/repos/'+repo+'/actions/workflows/'+encodeURIComponent(workflow)+'/runs?branch=main&per_page=30';
  const r=await fetch(api,{headers:githubHeaders(env)});
  if(!r.ok)return [];
  const d=await r.json();
  return Array.isArray(d.workflow_runs)?d.workflow_runs:[];
}
async function githubRunJobsForRepo(env,repo,runId){
  if(!runId)return [];
  const api='https://api.github.com/repos/'+repo+'/actions/runs/'+runId+'/jobs?per_page=100';
  const r=await fetch(api,{headers:githubHeaders(env)});
  if(!r.ok)return [];
  const d=await r.json();
  return Array.isArray(d.jobs)?d.jobs:[];
}
function videoFactoryStageFromJobs(jobs){
  const names=[];
  for(const j of jobs||[])for(const s of j.steps||[])if(s.status==='in_progress'||s.conclusion==='success')names.push(String(s.name||'').toLowerCase());
  const joined=names.join(' | ');
  if(/upload|youtube/.test(joined))return {status:'upload_pending',progress:96};
  if(/validat|verify|audit/.test(joined))return {status:'validating',progress:91};
  if(/render|ffmpeg/.test(joined))return {status:'rendering',progress:80};
  if(/narrat|voice|tts/.test(joined))return {status:'narrating',progress:68};
  if(/sonnet|script|writing|package/.test(joined))return {status:'scripting',progress:56};
  if(/visual|image|media|collect/.test(joined))return {status:'collecting_media',progress:43};
  if(/research|haiku/.test(joined))return {status:'researching',progress:26};
  return {status:'queued',progress:18};
}
async function refreshVideoFactoryProduction(env,row){
  row=normalizeVideoFactoryRow(row);
  if(!row||['completed','uploaded_private','failed'].includes(row.status))return row;
  const channel=videoFactoryChannel(row.channel_slug);
  if(!channel)return row;
  let suggestions=row.suggestions;
  if((row.generation_mode==='suggest'||row.generation_mode==='auto')&&!suggestions){
    try{
      const s=await githubRepoJson(env,channel.repo,'production/mfcc-topic-suggestions/'+row.id+'.json');
      if(s&&Array.isArray(s.suggestions)){
        suggestions=s.suggestions.slice(0,5);
        const selected=row.generation_mode==='auto'&&suggestions[0]?String(suggestions[0].topic||suggestions[0].title_idea||''):row.selected_topic;
        await env.DB.prepare("UPDATE video_productions SET suggestions_json=?, selected_topic=COALESCE(?,selected_topic), updated_at=? WHERE id=?")
          .bind(JSON.stringify(suggestions),selected||null,new Date().toISOString(),row.id).run();
        row.suggestions=suggestions;if(selected)row.selected_topic=selected;
      }
    }catch(_){}
  }
  if(row.generation_mode==='suggest'&&!row.selected_topic){
    if(suggestions&&suggestions.length){row.status='researching';row.progress=Math.max(Number(row.progress||0),15);}
    return row;
  }
  const createdMs=Date.parse(row.created_at||'')||0;
  const customRuns=await githubWorkflowRunsForRepo(env,channel.repo,'custom-topic-production.yml');
  let custom=customRuns.find(x=>row.dispatch_commit_sha&&x.head_sha===row.dispatch_commit_sha);
  if(!custom)custom=customRuns.find(x=>(Date.parse(x.created_at||'')||0)>=createdMs-30000);
  if(custom&&custom.conclusion==='failure'){
    await env.DB.prepare("UPDATE video_productions SET status='failed',error_message=?,github_run_id=?,github_run_url=?,updated_at=? WHERE id=?")
      .bind('O launcher de produção falhou no GitHub.',String(custom.id||''),String(custom.html_url||''),new Date().toISOString(),row.id).run();
    await videoFactoryEvent(env,row.id,'dispatch','failed','O launcher do GitHub falhou.',{run_id:custom.id,url:custom.html_url});
    return {...row,status:'failed',error_message:'O launcher de produção falhou no GitHub.',github_run_id:String(custom.id||''),github_run_url:custom.html_url};
  }
  if(!custom||custom.status!=='completed'){
    const progress=Math.max(Number(row.progress||0),custom?12:8);
    if(progress!==row.progress)await env.DB.prepare("UPDATE video_productions SET status='queued',progress=?,github_run_id=?,github_run_url=?,updated_at=? WHERE id=?")
      .bind(progress,custom?String(custom.id||''):row.github_run_id,custom?String(custom.html_url||''):row.github_run_url,new Date().toISOString(),row.id).run();
    return {...row,status:'queued',progress,github_run_id:custom?String(custom.id||''):row.github_run_id,github_run_url:custom?custom.html_url:row.github_run_url};
  }
  const dailyRuns=await githubWorkflowRunsForRepo(env,channel.repo,'daily-production.yml');
  const customCreated=Date.parse(custom.created_at||'')||createdMs;
  const daily=dailyRuns.filter(x=>(Date.parse(x.created_at||'')||0)>=customCreated-5000).sort((a,b)=>(Date.parse(a.created_at||0)-Date.parse(b.created_at||0)))[0]||null;
  if(!daily){
    const progress=Math.max(Number(row.progress||0),15);
    await env.DB.prepare("UPDATE video_productions SET status='queued',progress=?,github_run_id=?,github_run_url=?,updated_at=? WHERE id=?")
      .bind(progress,String(custom.id||''),String(custom.html_url||''),new Date().toISOString(),row.id).run();
    return {...row,status:'queued',progress,github_run_id:String(custom.id||''),github_run_url:custom.html_url};
  }
  if(daily.status==='completed'){
    if(daily.conclusion==='success'){
      await env.DB.prepare("UPDATE video_productions SET status='completed',progress=100,github_run_id=?,github_run_url=?,error_message=NULL,completed_at=?,updated_at=? WHERE id=?")
        .bind(String(daily.id||''),String(daily.html_url||''),new Date().toISOString(),new Date().toISOString(),row.id).run();
      await videoFactoryEvent(env,row.id,'production','completed','Produção concluída no GitHub.',{run_id:daily.id,url:daily.html_url});
      return {...row,status:'completed',progress:100,github_run_id:String(daily.id||''),github_run_url:daily.html_url,error_message:null};
    }
    await env.DB.prepare("UPDATE video_productions SET status='failed',progress=?,github_run_id=?,github_run_url=?,error_message=?,updated_at=? WHERE id=?")
      .bind(Math.max(Number(row.progress||0),20),String(daily.id||''),String(daily.html_url||''),'A produção terminou com falha no GitHub.',new Date().toISOString(),row.id).run();
    await videoFactoryEvent(env,row.id,'production','failed','A produção terminou com falha no GitHub.',{run_id:daily.id,url:daily.html_url});
    return {...row,status:'failed',github_run_id:String(daily.id||''),github_run_url:daily.html_url,error_message:'A produção terminou com falha no GitHub.'};
  }
  const jobs=await githubRunJobsForRepo(env,channel.repo,daily.id);
  const stage=videoFactoryStageFromJobs(jobs);
  await env.DB.prepare("UPDATE video_productions SET status=?,progress=?,github_run_id=?,github_run_url=?,updated_at=? WHERE id=?")
    .bind(stage.status,Math.max(Number(row.progress||0),stage.progress),String(daily.id||''),String(daily.html_url||''),new Date().toISOString(),row.id).run();
  return {...row,status:stage.status,progress:Math.max(Number(row.progress||0),stage.progress),github_run_id:String(daily.id||''),github_run_url:daily.html_url};
}
async function createVideoFactoryProduction(env,body){
  await ensureVideoFactorySchema(env);
  const channel=videoFactoryChannel(body.channel_slug||body.channel_id||body.channel);
  if(!channel)throw new Error('Canal de vídeo não configurado no MediaForge.');
  const mode=String(body.generation_mode||body.mode||'manual');
  if(!['manual','suggest','auto'].includes(mode))throw new Error('Modo de geração inválido.');
  const objective=String(body.objective||'viral_ctr');
  const topic=String(body.requested_topic||body.topic||'').trim();
  if(mode==='manual'&&topic.length<3)throw new Error('Informe um tema para a produção manual.');
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const upload=channel.allow_youtube_upload&&body.upload_requested?1:0;
  await env.DB.prepare("INSERT INTO video_productions(id,channel_id,channel_slug,channel_name,repo,requested_topic,selected_topic,generation_mode,objective,notes,upload_requested,status,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,channel.id,channel.slug,channel.name,channel.repo,mode==='manual'?topic:null,mode==='manual'?topic:null,mode,objective,String(body.notes||'').trim()||null,upload,mode==='manual'?'draft':'researching',0,now,now).run();
  await videoFactoryEvent(env,id,'request','created','Produção criada no MediaForge.',{channel:channel.slug,mode,objective});
  let payload,path,kind;
  if(mode==='manual'){
    path='production/custom-topic-request.json';kind='production';
    payload={id,topic,category:channel.slug==='nba-stars'?'NBA storytelling':'timely business/technology',working_angle:topic,title_seed:topic,thumbnail_text_seed:channel.slug==='nba-stars'?'NBA STORY':'MUST SEE',click_score:100,click_reason:'Requested from MediaForge Control Center.',objective,upload_requested:!!upload,mfcc_production_id:id,notes:String(body.notes||'')};
  }else{
    path='production/mfcc-topic-request.json';kind='intelligence';
    payload={request_id:id,production_id:id,mode,objective,notes:String(body.notes||''),upload_requested:!!upload,channel_name:channel.name,niche:channel.niche};
  }
  try{
    const g=await githubQueueFileToRepo(env,channel.repo,path,payload,'MediaForge: '+kind+' '+id);
    const sha=String(g?.commit?.sha||'');
    await env.DB.prepare("UPDATE video_productions SET status=?,progress=?,dispatch_kind=?,dispatch_commit_sha=?,updated_at=? WHERE id=?")
      .bind(mode==='manual'?'queued':'researching',mode==='manual'?5:8,kind,sha,new Date().toISOString(),id).run();
    await videoFactoryEvent(env,id,'dispatch','queued',mode==='manual'?'Pedido enviado à fábrica GitHub.':'Pedido de inteligência enviado ao GitHub.',{commit_sha:sha,repo:channel.repo});
  }catch(e){
    await env.DB.prepare("UPDATE video_productions SET status='failed',error_message=?,updated_at=? WHERE id=?").bind(String(e?.message||e),new Date().toISOString(),id).run();
    await videoFactoryEvent(env,id,'dispatch','failed','Falha ao enviar pedido ao GitHub.',{error:String(e?.message||e)});
    throw e;
  }
  const row=await env.DB.prepare("SELECT * FROM video_productions WHERE id=?").bind(id).first();
  return normalizeVideoFactoryRow(row);
}
async function getVideoFactoryProduction(env,id,refresh){
  await ensureVideoFactorySchema(env);
  let row=await env.DB.prepare("SELECT * FROM video_productions WHERE id=?").bind(String(id)).first();
  if(!row)return null;
  if(refresh)row=await refreshVideoFactoryProduction(env,row);
  const ev=await env.DB.prepare("SELECT id,stage,status,message,payload_json,created_at FROM video_production_events WHERE production_id=? ORDER BY created_at ASC").bind(String(id)).all();
  return {production:normalizeVideoFactoryRow(row),events:(ev.results||[]).map(x=>{let payload={};try{payload=JSON.parse(x.payload_json||'{}')}catch(_){}return {...x,payload};})};
}
async function getVideoFactorySuggestions(env,id){
  await ensureVideoFactorySchema(env);
  let row=await env.DB.prepare("SELECT * FROM video_productions WHERE id=?").bind(String(id)).first();
  if(!row)throw new Error('Produção não encontrada.');
  row=normalizeVideoFactoryRow(row);
  const channel=videoFactoryChannel(row.channel_slug);
  let suggestions=row.suggestions;
  if(!suggestions){
    const s=await githubRepoJson(env,channel.repo,'production/mfcc-topic-suggestions/'+row.id+'.json');
    if(s&&Array.isArray(s.suggestions)){
      suggestions=s.suggestions.slice(0,5);
      const autoTopic=row.generation_mode==='auto'&&suggestions[0]?String(suggestions[0].topic||suggestions[0].title_idea||''):null;
      await env.DB.prepare("UPDATE video_productions SET suggestions_json=?,selected_topic=COALESCE(?,selected_topic),updated_at=? WHERE id=?")
        .bind(JSON.stringify(suggestions),autoTopic,new Date().toISOString(),row.id).run();
      await videoFactoryEvent(env,row.id,'ideas','ready','As 5 ideias foram geradas.',{count:suggestions.length});
    }
  }
  return {ready:!!(suggestions&&suggestions.length),suggestions:suggestions||[]};
}
async function selectVideoFactorySuggestion(env,id,index){
  await ensureVideoFactorySchema(env);
  const row=normalizeVideoFactoryRow(await env.DB.prepare("SELECT * FROM video_productions WHERE id=?").bind(String(id)).first());
  if(!row)throw new Error('Produção não encontrada.');
  const channel=videoFactoryChannel(row.channel_slug);
  const sr=await getVideoFactorySuggestions(env,id);
  if(!sr.ready)throw new Error('As sugestões ainda não estão prontas.');
  const i=Number(index);
  if(!Number.isInteger(i)||i<0||i>=sr.suggestions.length)throw new Error('Sugestão inválida.');
  const s=sr.suggestions[i],topic=String(s.topic||s.title_idea||'').trim();
  const payload={id:row.id,topic,category:channel.slug==='nba-stars'?'NBA storytelling':'timely business/technology',working_angle:String(s.title_idea||topic),title_seed:String(s.title_idea||topic),thumbnail_text_seed:channel.slug==='nba-stars'?'NBA STORY':'MUST SEE',click_score:Number(s.score||100),click_reason:String(s.reason||'Selected in MediaForge.'),objective:row.objective,upload_requested:!!row.upload_requested,mfcc_production_id:row.id,mfcc_selected_suggestion:true};
  const g=await githubQueueFileToRepo(env,channel.repo,'production/custom-topic-request.json',payload,'MediaForge: selected idea '+row.id);
  const sha=String(g?.commit?.sha||'');
  await env.DB.prepare("UPDATE video_productions SET selected_topic=?,status='queued',progress=10,dispatch_kind='production',dispatch_commit_sha=?,updated_at=? WHERE id=?")
    .bind(topic,sha,new Date().toISOString(),row.id).run();
  await videoFactoryEvent(env,row.id,'ideas','selected','Ideia selecionada e enviada para produção.',{index:i,topic,commit_sha:sha});
  return normalizeVideoFactoryRow(await env.DB.prepare("SELECT * FROM video_productions WHERE id=?").bind(row.id).first());
}

const OVH_SLOTS=['kick','twitch','youtube-deep-house','youtube-rainy','youtube-gta-vi'];
const OVH_DEPLOY_TARGETS=['ovh-agent','control-api','kick','twitch','youtube-deep-house','youtube-rainy'];
const OVH_DEPLOY_ACTIONS=['deploy_service','deploy_all','deploy_host_agent','health_check','diagnose_service','repair_gta_runtime','rollback_service','hot_patch_streaming','reload_control_agent'];
function ovhAgentAllowed(request,env){
  // The agent token is the primary credential in every runtime. Previously it
  // was only honored when LOCAL_RUNTIME=1, which made production control
  // depend on the VPS egress IP and broke skip/previous when that IP changed.
  const expected=String(env.OVH_AGENT_TOKEN||'');
  const provided=String(request.headers.get('x-ovh-agent-token')||'');
  if(expected&&provided&&provided===expected)return {ok:true,ip:'token-authenticated'};
  const ip=request.headers.get('cf-connecting-ip')||'',lower=ip.toLowerCase();
  const allowed=String(env.OVH_AGENT_IPS||'146.59.156.224,2001:41d0:305:2100::1:7dfb').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const v6Prefixes=String(env.OVH_AGENT_IPV6_PREFIXES||'2001:41d0:305:2100:').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  return {ok:allowed.includes(lower)||v6Prefixes.some(p=>lower.startsWith(p)),ip};
}
function localMigrationAllowed(request,env){
  if(String(env.LOCAL_RUNTIME||'')!=='1')return false;
  const expected=String(env.LOCAL_MIGRATION_TOKEN||'');
  const provided=String(request.headers.get('x-local-migration-token')||'');
  return !!expected&&provided===expected;
}
const MIGRATION_TABLES={
  assets:['id','title','asset_type','r2_key','mime_type','size_bytes','status','download_token','metadata_json','created_at'],
  live_sessions:['id','platform','status','title','description','duration_minutes','track_ids_json','visual_asset_id','github_run_id','github_run_url','error_message','created_at','live_at','completed_at'],
  live_session_assets:['session_id','role','asset_id'],
  live_runtime:['session_id','runtime','runtime_slot','last_status_at','agent_status_json'],
  ovh_state:['id','payload_json','updated_at'],
  ovh_commands:['id','runtime_slot','action','payload_json','status','created_at','claimed_at','completed_at','error'],
  ovh_deploy_commands:['id','action','target','payload_json','status','created_at','claimed_at','completed_at','error','result_json'],
  music_generation_jobs:['id','series_key','playlist_name','duration_minutes','status','progress','phase','github_run_id','github_run_url','release_tag','master_audio_url','error','created_at','updated_at','completed_at','result_json'],
  dj_catalog_scans:['id','token_hash','status','total','processed','allowed','restricted','not_found','ambiguous','error_count','created_at','updated_at','completed_at','expires_at'],
  dj_catalog_results:['scan_id','position','spotify_id','title','artists','status','matched_title','matched_artists','match_score','twitch_track_id','checked_at','detail_json'],
  dj_catalog_audio_sources:['scan_id','position','asset_id','acquisition_source','acquisition_note','verified_owned','created_at','updated_at']
};
async function localConfigJson(env,path){
  try{
    const row=await env.DB.prepare('SELECT payload_json FROM local_config WHERE path=?').bind(String(path)).first();
    return row?JSON.parse(row.payload_json||'null'):null;
  }catch(_){return null;}
}
async function setLocalConfig(env,path,payload){
  const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO local_config(path,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').bind(String(path),JSON.stringify(payload),now).run();
}
async function exportTable(env,table){
  if(!Object.prototype.hasOwnProperty.call(MIGRATION_TABLES,table))throw new Error('migration_table_not_allowed');
  const q=await env.DB.prepare('SELECT * FROM '+table).all();
  return q.results||[];
}
async function importTableRows(env,table,rows){
  const cols=MIGRATION_TABLES[table];
  if(!cols||!Array.isArray(rows))return 0;
  let count=0;
  for(const row of rows){
    const values=cols.map(c=>row?.[c]??null);
    const sql='INSERT OR REPLACE INTO '+table+'('+cols.join(',')+') VALUES('+cols.map(()=>'?').join(',')+')';
    await env.DB.prepare(sql).bind(...values).run();
    count++;
  }
  return count;
}


async function googleAccessToken(env){
  const clientId=String(env.YOUTUBE_CLIENT_ID||'').trim();
  const clientSecret=String(env.YOUTUBE_CLIENT_SECRET||'').trim();
  const refreshToken=String(env.YOUTUBE_REFRESH_TOKEN||'').trim();
  if(!clientId||!clientSecret||!refreshToken)throw new Error('Credenciais OAuth do YouTube ainda não foram migradas para a OVH.');
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token)throw new Error('Falha ao renovar OAuth do YouTube: '+String(d.error_description||d.error||r.status));
  return String(d.access_token);
}
async function youtubeFetch(env,path,{method='GET',query={},body=null,headers={}}={}){
  const token=await googleAccessToken(env);
  const u=new URL('https://www.googleapis.com/youtube/v3/'+path);
  for(const [k,v] of Object.entries(query||{}))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
  const h={authorization:'Bearer '+token,...headers};
  let payload=body;
  if(body&&!(body instanceof ArrayBuffer)&&!(body instanceof Uint8Array)&&typeof body!=='string'&&!(body instanceof ReadableStream)){
    h['content-type']='application/json';
    payload=JSON.stringify(body);
  }
  const r=await fetch(u,{method,headers:h,body:payload});
  const text=await r.text();
  let d={};try{d=text?JSON.parse(text):{}}catch(_){d={raw:text.slice(0,1000)}}
  if(!r.ok)throw new Error('YouTube API '+r.status+': '+String(d?.error?.message||d?.error_description||d?.raw||text.slice(0,500)));
  return d;
}
async function ensureYoutubeStreamForStation(env,cfg,station){
  const slot=String(station?.ovh_slot||'');
  if(slot!=='youtube-gta-vi'){
    if(!station?.youtube_stream_id)throw new Error('Slot YouTube OVH não configurado: '+slot);
    return {station,streamId:String(station.youtube_stream_id),streamUrl:'',streamKey:''};
  }

  let stream=null;
  if(station.youtube_stream_id){
    try{
      const listed=await youtubeFetch(env,'liveStreams',{query:{part:'id,snippet,cdn,status,contentDetails',id:String(station.youtube_stream_id)}});
      stream=(listed.items||[])[0]||null;
    }catch(_){}
  }
  if(!stream){
    stream=await youtubeFetch(env,'liveStreams',{
      method:'POST',
      query:{part:'id,snippet,cdn,status,contentDetails'},
      body:{
        snippet:{title:'Peter Lofi — GTA VI Vice City Live'},
        cdn:{ingestionType:'rtmp',resolution:'1080p',frameRate:'60fps'},
        contentDetails:{isReusable:true}
      }
    });
    if(!stream?.id)throw new Error('YouTube não retornou stream_id para o slot GTA VI.');
    station.youtube_stream_id=String(stream.id);
    station.status='stopped';
    station.current_session_id=null;
    station.provisioned_at=new Date().toISOString();
    cfg.updated_at=new Date().toISOString();
    await setLocalConfig(env,'control/youtube-stations.json',cfg);
  }

  const info=stream?.cdn?.ingestionInfo||{};
  const streamUrl=String(info.rtmpsIngestionAddress||info.ingestionAddress||'').trim();
  const streamKey=String(info.streamName||'').trim();
  if(!streamUrl||!streamKey)throw new Error('O YouTube não retornou endereço/chave de ingestão para o slot GTA VI.');
  return {station,streamId:String(stream.id||station.youtube_stream_id),streamUrl,streamKey};
}

async function prepareYoutubeLocal(request,env,{sessionId,slot,title,description,thumbnailUrl,durationMinutes,loopUrl,tracks,playlistKey}){
  const cfg=await getYoutubeStations(env),station=(cfg.stations||[]).find(x=>String(x.ovh_slot||'')===String(slot));
  if(!station)throw new Error('Slot YouTube OVH não configurado: '+slot);
  const provisioned=await ensureYoutubeStreamForStation(env,cfg,station);
  const current=String(station.current_session_id||''),state=String(station.status||'').toLowerCase();
  if(current&&current!==sessionId&&['live','starting'].includes(state))throw new Error('Slot YouTube ocupado por '+current);
  const now=new Date(),scheduled=new Date(now.getTime()+20000).toISOString();
  const broadcast=await youtubeFetch(env,'liveBroadcasts',{
    method:'POST',
    query:{part:'snippet,status,contentDetails'},
    body:{
      snippet:{title:String(title||'Peter Lofi — Live').slice(0,100),description:String(description||'').slice(0,5000),categoryId:'10',scheduledStartTime:scheduled},
      status:{privacyStatus:'public',selfDeclaredMadeForKids:false},
      contentDetails:{enableAutoStart:true,enableAutoStop:false,monitorStream:{enableMonitorStream:false}}
    }
  });
  const bid=String(broadcast.id||'');if(!bid)throw new Error('YouTube não retornou o broadcast_id.');
  const streamId=String(provisioned.streamId);
  await youtubeFetch(env,'liveBroadcasts/bind',{method:'POST',query:{part:'id,contentDetails',id:bid,streamId}});
  let thumbOk=false;
  if(thumbnailUrl){
    try{
      const imageRes=await fetch(thumbnailUrl);
      if(!imageRes.ok)throw new Error('thumbnail HTTP '+imageRes.status);
      const bytes=await imageRes.arrayBuffer(),token=await googleAccessToken(env);
      const up=await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId='+encodeURIComponent(bid),{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':imageRes.headers.get('content-type')||'image/jpeg'},body:bytes
      });
      if(!up.ok)throw new Error('thumbnail upload '+up.status+' '+(await up.text()).slice(0,300));
      thumbOk=true;
    }catch(e){console.log('YouTube thumbnail skipped:',e?.message||String(e))}
  }
  const cmd=await issueOvhCommand(env,{action:'start',platform:'youtube',runtime_slot:slot,session_id:sessionId,title,description,duration_minutes:Number(durationMinutes||0),loop_url:String(loopUrl||''),playlist_key:playlistKey||null,tracks:tracks||[],shuffle:true,repeat:true,source:'mediaforge-youtube-local',...(slot==='youtube-gta-vi'?{stream_url:provisioned.streamUrl,stream_key:provisioned.streamKey}:{})});
  // The reusable stream may already be active, but a stopped slot can need a few
  // seconds after the local OVH command. Drive the YouTube lifecycle directly
  // instead of delegating this step to GitHub Actions.
  let lifecycle='ready',streamStatus='';
  for(let n=0;n<8;n++){
    try{
      const streams=await youtubeFetch(env,'liveStreams',{query:{part:'status',id:streamId}});
      streamStatus=String(streams?.items?.[0]?.status?.streamStatus||'');
      const broadcasts=await youtubeFetch(env,'liveBroadcasts',{query:{part:'status',id:bid}});
      lifecycle=String(broadcasts?.items?.[0]?.status?.lifeCycleStatus||lifecycle);
      if(lifecycle==='live')break;
      if(['active','ready'].includes(streamStatus)){
        if(lifecycle==='ready'){
          try{await youtubeFetch(env,'liveBroadcasts/transition',{method:'POST',query:{part:'status',id:bid,broadcastStatus:'testing'}});}catch(_){}
          await new Promise(r=>setTimeout(r,1200));
        }
        const refreshed=await youtubeFetch(env,'liveBroadcasts',{query:{part:'status',id:bid}});
        lifecycle=String(refreshed?.items?.[0]?.status?.lifeCycleStatus||lifecycle);
        if(['testing','testStarting','ready'].includes(lifecycle)){
          try{await youtubeFetch(env,'liveBroadcasts/transition',{method:'POST',query:{part:'status',id:bid,broadcastStatus:'live'}});}catch(_){}
        }
      }
    }catch(_){}
    await new Promise(r=>setTimeout(r,1500));
  }
  try{
    const finalState=await youtubeFetch(env,'liveBroadcasts',{query:{part:'status',id:bid}});
    lifecycle=String(finalState?.items?.[0]?.status?.lifeCycleStatus||lifecycle);
  }catch(_){}
  const result={platform:'youtube',runtime:'ovh',runtime_slot:slot,status:lifecycle==='live'?'live':'starting',youtube_lifecycle:lifecycle,youtube_stream_status:streamStatus,title,description,youtube_broadcast_id:bid,youtube_stream_id:streamId,youtube_url:'https://www.youtube.com/watch?v='+bid,privacy_status:'public',encoder_resolution:'1920x1080',encoder_fps:60,encoder_bitrate_kbps:8000,custom_thumbnail_applied:thumbOk,created_at:now.toISOString(),updated_at:new Date().toISOString()};
  await setLocalConfig(env,'control/live-results/'+sessionId+'.json',result);
  station.runtime='ovh';station.status=result.status;station.current_session_id=sessionId;station.youtube_broadcast_id=bid;station.last_started_at=now.toISOString();
  cfg.updated_at=new Date().toISOString();await setLocalConfig(env,'control/youtube-stations.json',cfg);
  return {result,command:cmd};
}
async function stopYoutubeLocal(env,{sessionId,slot,title}){
  const result=(await localConfigJson(env,'control/live-results/'+sessionId+'.json'))||{};
  const bid=String(result.youtube_broadcast_id||'');
  if(bid){
    try{
      const d=await youtubeFetch(env,'liveBroadcasts',{query:{part:'status',id:bid}});
      const lifecycle=String(d?.items?.[0]?.status?.lifeCycleStatus||'');
      if(lifecycle==='live')await youtubeFetch(env,'liveBroadcasts/transition',{method:'POST',query:{part:'status',id:bid,broadcastStatus:'complete'}});
    }catch(e){console.log('YouTube complete warning:',e?.message||String(e))}
  }
  const now=new Date().toISOString(),cmd=await issueOvhCommand(env,{action:'stop',platform:'youtube',runtime_slot:slot,session_id:sessionId,title:String(title||result.title||''),source:'mediaforge-youtube-local-stop'});
  const cfg=await getYoutubeStations(env),station=(cfg.stations||[]).find(x=>String(x.ovh_slot||'')===String(slot));
  if(station&&String(station.current_session_id||'')===String(sessionId)){
    station.status='stopped';station.current_session_id=null;station.youtube_broadcast_id=null;station.last_stopped_at=now;cfg.updated_at=now;await setLocalConfig(env,'control/youtube-stations.json',cfg);
  }
  const next={...result,status:'completed',runtime:'ovh',runtime_slot:slot,completed_at:now,updated_at:now};
  await setLocalConfig(env,'control/live-results/'+sessionId+'.json',next);
  return {result:next,command:cmd};
}
async function catalogGeneratedPlaylist(env,job,result){
  const library=await getMusicLibrary(env),cfg=await getPeterLofiSeriesConfig(env);
  const preset=(cfg.series||[]).find(x=>String(x.key||'')===String(job.series_key||''))||{};
  const dna=preset.music_dna||{},key=String(result.library_key||('generated-'+String(job.series_key||'custom')+'-'+String(job.id).slice(0,8)));
  const tracks=Array.isArray(result.tracks)?result.tracks:[];
  const playlist={key,name:String(job.playlist_name||preset.name||key),category:'Generated',series:String(preset.name||job.series_key||'Custom'),genre:String((dna.style_pool||[])[0]||'Lofi'),moods:dna.mood||[],source:'mediaforge-generator-ovh',release_tag:null,master_audio_url:result.master_audio_url||null,track_count:tracks.length,total_duration_seconds:Math.round(tracks.reduce((n,t)=>n+Number(t.duration_seconds||0),0)),tracks};
  library.playlists=[...(library.playlists||[]).filter(x=>String(x.key)!==key),playlist];
  library.updated_at=new Date().toISOString();
  await setLocalConfig(env,'control/music-library.json',library);
  return playlist;
}

async function logOvhDenied(env,request,route){
  try{
    const ip=String(request.headers.get('cf-connecting-ip')||'').slice(0,128);
    const ua=String(request.headers.get('user-agent')||'').slice(0,300);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ovh_access_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, route TEXT, user_agent TEXT, created_at TEXT)`).run();
    await env.DB.prepare(`INSERT INTO ovh_access_log(ip,route,user_agent,created_at) VALUES(?,?,?,?)`).bind(ip,String(route||'').slice(0,200),ua,new Date().toISOString()).run();
    await env.DB.prepare(`DELETE FROM ovh_access_log WHERE id NOT IN (SELECT id FROM ovh_access_log ORDER BY id DESC LIMIT 100)`).run();
  }catch(_){}
}

function mapPlatformFromSlot(slot){return String(slot||'').startsWith('youtube-')?'youtube':String(slot||'');}
async function getYoutubeStations(env){
  const cfg=(await fetchGithubJson(env,'control/youtube-stations.json'))||{version:1,stations:[]};
  cfg.stations=Array.isArray(cfg.stations)?cfg.stations:[];
  if(String(env.LOCAL_RUNTIME||'')==='1'&&!cfg.stations.some(x=>String(x.ovh_slot||'')==='youtube-gta-vi')){
    cfg.stations.push({
      key:'gta-vi',
      name:'GTA VI - Vice City',
      ovh_slot:'youtube-gta-vi',
      runtime:'ovh',
      status:'stopped',
      current_session_id:null,
      youtube_broadcast_id:null,
      youtube_stream_id:null,
      purpose:'Dedicated third YouTube slot for GTA VI without interrupting Deep House or Rainy.'
    });
    cfg.updated_at=new Date().toISOString();
    await setLocalConfig(env,'control/youtube-stations.json',cfg);
  }
  return cfg;
}
async function getMusicLibrary(env){return (await fetchGithubJson(env,'control/music-library.json'))||{version:1,playlists:[]};}
async function getPeterLofiSeriesConfig(env){return (await fetchGithubJson(env,'config/peter_lofi_series.json'))||{series:[]};}
async function syncMusicGenerationJob(env,row){
  if(!row)return null;
  if(String(env.LOCAL_RUNTIME||'')==='1')return row;
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
  if(String(command?.source||'')==='mediaforge-visual-switch') command={...command,action:'set_visual'};
  const payload={...command,id,runtime:'ovh',requested_at:command.requested_at||now};
  await env.DB.prepare(`INSERT OR REPLACE INTO ovh_commands(id,runtime_slot,action,payload_json,status,created_at,claimed_at,completed_at,error) VALUES(?,?,?,?, 'pending', ?,NULL,NULL,NULL)`).bind(id,String(payload.runtime_slot||''),String(payload.action||''),JSON.stringify(payload),now).run();
  const realtimeAudioControl=['skip','previous'].includes(String(payload.action||'').toLowerCase());
  if(String(env.LOCAL_RUNTIME||'')!=='1'){
    try{
      // Mirror every command, including realtime audio controls. D1 is still
      // primary; GitHub is an independent fallback when the OVH agent misses
      // the remote queue. Unique IDs keep rapid skip/previous clicks distinct.
      await githubQueueFile(env,path,payload,`mediaforge ovh command ${id}`);
      const idx=(await fetchGithubJson(env,'control/ovh-commands/index.json'))||{version:1,commands:[]};
      const commands=[...(idx.commands||[]).filter(x=>String(x.id)!==id),{id,path,created_at:now,realtime:realtimeAudioControl}].slice(-500);
      await githubQueueFile(env,'control/ovh-commands/index.json',{version:1,updated_at:now,commands},'mediaforge ovh command index');
    }catch(_){}
  }
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
function assetPublicUrl(request,asset,env=null){
  const base=String(env?.PUBLIC_BASE_URL||new URL(request.url).origin).replace(/\/$/,'');
  return `${base}/media/${asset.id}/${asset.download_token}`;
}
function assetRuntimeUrl(request,asset,env){
  if(String(env.LOCAL_RUNTIME||'')==='1'){
    return `http://127.0.0.1:8790/media/${asset.id}/${asset.download_token}`;
  }
  return assetPublicUrl(request,asset,env);
}
async function readAsset(env,id){return env.DB.prepare(`SELECT * FROM assets WHERE id=?`).bind(id).first();}
async function assetSummary(request,env,id){if(!id)return null;const a=await readAsset(env,id);return a?{id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,public_url:assetPublicUrl(request,a,env)}:null;}

async function sha256hex(value){
  const bytes=await crypto.subtle.digest('SHA-256',enc.encode(String(value||'')));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function djScanRowByBridgeToken(env,id,token){
  if(!id||!token)return null;
  const hash=await sha256hex(token),row=await env.DB.prepare(`SELECT * FROM dj_catalog_scans WHERE id=? AND token_hash=?`).bind(id,hash).first();
  if(!row)return null;
  if(Date.parse(row.expires_at||'')<Date.now())return null;
  return row;
}
function djResultStatus(v){
  const x=String(v||'').toLowerCase();
  return ['allowed','restricted','not_found','ambiguous','error'].includes(x)?x:'error';
}
async function djRecount(env,id){
  const q=await env.DB.prepare(`SELECT status,COUNT(*) AS n FROM dj_catalog_results WHERE scan_id=? GROUP BY status`).bind(id).all();
  const counts={allowed:0,restricted:0,not_found:0,ambiguous:0,error:0};
  for(const r of q.results||[])if(Object.prototype.hasOwnProperty.call(counts,String(r.status)))counts[String(r.status)]=Number(r.n||0);
  const processed=Object.values(counts).reduce((a,b)=>a+b,0),row=await env.DB.prepare(`SELECT total FROM dj_catalog_scans WHERE id=?`).bind(id).first(),total=Number(row?.total||0);
  const status=processed>=total&&total>0?'completed':processed>0?'running':'pending',now=new Date().toISOString(),completed=status==='completed'?now:null;
  await env.DB.prepare(`UPDATE dj_catalog_scans SET status=?,processed=?,allowed=?,restricted=?,not_found=?,ambiguous=?,error_count=?,updated_at=?,completed_at=COALESCE(?,completed_at) WHERE id=?`).bind(status,processed,counts.allowed,counts.restricted,counts.not_found,counts.ambiguous,counts.error,now,completed,id).run();
  return {status,total,processed,...counts};
}
async function djScanSummary(env,row,includeResults=false){
  if(!row)return null;
  const base={id:row.id,status:row.status,total:Number(row.total||0),processed:Number(row.processed||0),allowed:Number(row.allowed||0),restricted:Number(row.restricted||0),not_found:Number(row.not_found||0),ambiguous:Number(row.ambiguous||0),error_count:Number(row.error_count||0),created_at:row.created_at,updated_at:row.updated_at,completed_at:row.completed_at,expires_at:row.expires_at};
  if(!includeResults)return base;
  const q=await env.DB.prepare(`SELECT position,spotify_id,title,artists,status,matched_title,matched_artists,match_score,twitch_track_id,checked_at,detail_json FROM dj_catalog_results WHERE scan_id=? ORDER BY position`).bind(row.id).all();
  return {...base,results:(q.results||[]).map(r=>{let detail={};try{detail=JSON.parse(r.detail_json||'{}')}catch(_){}return {...r,detail};})};
}

async function handleMedia(request,env,url){const parts=url.pathname.split('/').filter(Boolean),id=parts[1]||'',token=parts[2]||'',asset=await env.DB.prepare(`SELECT * FROM assets WHERE id=? AND download_token=? AND status='ready'`).bind(id,token).first();if(!asset)return new Response('Not found',{status:404});const object=await env.MEDIA.get(asset.r2_key);if(!object)return new Response('Not found',{status:404});const headers=new Headers();if(object.writeHttpMetadata)object.writeHttpMetadata(headers);headers.set('etag',object.httpEtag||object.etag||'');headers.set('cache-control','public, max-age=3600');headers.set('accept-ranges','bytes');return new Response(object.body,{headers});}

async function handleApi(request,env,url){
  const cors=corsHeaders(request,env);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(url.pathname==='/api/health')return json({ok:true,service:'mediaforge-api',storage:String(env.LOCAL_RUNTIME||'')==='1'?'ovh-local-r2':'r2',database:String(env.LOCAL_RUNTIME||'')==='1'?'ovh-sqlite-d1':'d1',supabase:false,youtube:true,kick:true,twitch:true,ovh:true,local_runtime:String(env.LOCAL_RUNTIME||'')==='1'},200,cors);


  // One-time, content-scoped bridge for the user-supplied second live visual.
  // Only the SHA-256 hash of the temporary token is committed. The route is
  // removed immediately after the verified upload.
  if(url.pathname==='/api/ops/20261006-second-visual-upload'&&request.method==='PUT'){
    const expectedTokenHash='8d7580941cc6301756d50c830878c00ce06554514bda063b49da6fa6eb6c089e';
    const provided=String(request.headers.get('x-upload-token')||'');
    if(!provided||await sha256hex(provided)!==expectedTokenHash)return json({error:'forbidden_upload_bridge'},403,cors);
    const expectedSize=73674717;
    const size=Number(request.headers.get('content-length')||0);
    const mime=String(request.headers.get('content-type')||'').toLowerCase();
    if(size!==expectedSize)return json({error:'unexpected_upload_size',expected:expectedSize,received:size},400,cors);
    if(mime!=='video/mp4')return json({error:'unexpected_upload_type',expected:'video/mp4',received:mime},400,cors);

    const existing=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' AND asset_type='loop' AND size_bytes=? AND title=? ORDER BY created_at DESC LIMIT 1`).bind(expectedSize,'VÍDEO YOUTUBE 4K.mp4').first();
    if(existing)return json({ok:true,deduplicated:true,asset:{id:existing.id,title:existing.title,asset_type:existing.asset_type,mime_type:existing.mime_type,size_bytes:existing.size_bytes,created_at:existing.created_at,public_url:assetPublicUrl(request,existing,env),runtime_url:assetRuntimeUrl(request,existing,env)}},200,cors);

    const assetId=crypto.randomUUID(),downloadToken=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),now=new Date().toISOString();
    const key=`loop/2026-10-06/${assetId}-video-youtube-4k.mp4`;
    await env.MEDIA.put(key,request.body,{httpMetadata:{contentType:'video/mp4',cacheControl:'public, max-age=3600'}});
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      assetId,'VÍDEO YOUTUBE 4K.mp4','loop',key,'video/mp4',expectedSize,'ready',downloadToken,
      JSON.stringify({live_visual:true,loop_forever:true,source:'chat-one-time-bridge',sha256:'59b98d8829f2cd10a03ef56bb17cdd3a177f8f09cfed94e36e7b5519573acc0b'}),
      now
    ).run();
    const ready=await readAsset(env,assetId);
    return json({ok:true,deduplicated:false,asset:{id:ready.id,title:ready.title,asset_type:ready.asset_type,mime_type:ready.mime_type,size_bytes:ready.size_bytes,created_at:ready.created_at,public_url:assetPublicUrl(request,ready,env),runtime_url:assetRuntimeUrl(request,ready,env)}},201,cors);
  }


  if(url.pathname==='/api/ops/20261006-import-second-visual'&&request.method==='GET'){
    const expectedTokenHash='8d7580941cc6301756d50c830878c00ce06554514bda063b49da6fa6eb6c089e';
    const provided=String(url.searchParams.get('token')||'');
    if(!provided||await sha256hex(provided)!==expectedTokenHash)return json({error:'forbidden_import_bridge'},403,cors);
    const source=String(url.searchParams.get('source')||'');
    let sourceUrl;
    try{sourceUrl=new URL(source);}catch(_){return json({error:'invalid_source_url'},400,cors);}
    if(sourceUrl.protocol!=='https:'||sourceUrl.hostname!=='d2jqrm6oza8nb6.cloudfront.net'||sourceUrl.pathname!=='/datasets/741dc69e-1f32-4f51-b117-73cba0afd6eb.mp4'){
      return json({error:'source_not_allowed'},403,cors);
    }
    const expectedSize=73674717;
    const existing=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' AND asset_type='loop' AND size_bytes=? AND title=? ORDER BY created_at DESC LIMIT 1`).bind(expectedSize,'VÍDEO YOUTUBE 4K.mp4').first();
    if(existing)return json({ok:true,deduplicated:true,asset:{id:existing.id,title:existing.title,asset_type:existing.asset_type,mime_type:existing.mime_type,size_bytes:existing.size_bytes,created_at:existing.created_at,public_url:assetPublicUrl(request,existing,env),runtime_url:assetRuntimeUrl(request,existing,env)}},200,cors);

    const upstream=await fetch(sourceUrl.toString(),{redirect:'follow'});
    if(!upstream.ok||!upstream.body)return json({error:'source_fetch_failed',status:upstream.status},502,cors);
    const upstreamLength=Number(upstream.headers.get('content-length')||0);
    if(upstreamLength&&upstreamLength!==expectedSize)return json({error:'source_size_mismatch',expected:expectedSize,received:upstreamLength},409,cors);

    const assetId=crypto.randomUUID(),downloadToken=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),now=new Date().toISOString();
    const key=`loop/2026-10-06/${assetId}-video-youtube-4k.mp4`;
    await env.MEDIA.put(key,upstream.body,{httpMetadata:{contentType:'video/mp4',cacheControl:'public, max-age=3600'}});
    const stored=await env.MEDIA.head(key);
    const storedSize=Number(stored?.size||0);
    if(storedSize&&storedSize!==expectedSize){
      try{await env.MEDIA.delete(key);}catch(_){}
      return json({error:'stored_size_mismatch',expected:expectedSize,received:storedSize},500,cors);
    }
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      assetId,'VÍDEO YOUTUBE 4K.mp4','loop',key,'video/mp4',expectedSize,'ready',downloadToken,
      JSON.stringify({live_visual:true,loop_forever:true,source:'chat-private-server-copy',sha256:'59b98d8829f2cd10a03ef56bb17cdd3a177f8f09cfed94e36e7b5519573acc0b'}),
      now
    ).run();
    const ready=await readAsset(env,assetId);
    return json({ok:true,deduplicated:false,asset:{id:ready.id,title:ready.title,asset_type:ready.asset_type,mime_type:ready.mime_type,size_bytes:ready.size_bytes,created_at:ready.created_at,public_url:assetPublicUrl(request,ready,env),runtime_url:assetRuntimeUrl(request,ready,env)}},201,cors);
  }

  if(url.pathname==='/api/migration/export'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_migration_export',ip:gate.ip},403,cors);
    const tables={};
    for(const table of Object.keys(MIGRATION_TABLES))tables[table]=await exportTable(env,table);
    const configs={
      'control/mediaforge-catalog.json':await getCatalog(env).catch(()=>null),
      'control/music-library.json':await getMusicLibrary(env).catch(()=>null),
      'control/youtube-stations.json':await getYoutubeStations(env).catch(()=>null),
      'config/peter_lofi_series.json':await getPeterLofiSeriesConfig(env).catch(()=>null)
    };
    return json({version:1,exported_at:new Date().toISOString(),origin:url.origin,tables,configs},200,cors);
  }

  if(url.pathname==='/api/local/import-snapshot'&&request.method==='POST'){
    if(!localMigrationAllowed(request,env))return json({error:'forbidden_local_migration'},403,cors);
    const b=await bodyJson(request),counts={};
    for(const table of Object.keys(MIGRATION_TABLES))counts[table]=await importTableRows(env,table,b?.tables?.[table]||[]);
    for(const [path,payload] of Object.entries(b?.configs||{}))if(payload!==null&&payload!==undefined)await setLocalConfig(env,path,payload);
    return json({ok:true,counts,configs:Object.keys(b?.configs||{}),imported_at:new Date().toISOString()},200,cors);
  }

  if(url.pathname==='/api/local/import-object'&&request.method==='PUT'){
    if(!localMigrationAllowed(request,env))return json({error:'forbidden_local_migration'},403,cors);
    const key=String(url.searchParams.get('key')||'').trim();if(!key)return json({error:'key_required'},400,cors);
    const mime=String(request.headers.get('content-type')||'application/octet-stream');
    await env.MEDIA.put(key,request.body,{httpMetadata:{contentType:mime,cacheControl:'public, max-age=3600'}});
    return json({ok:true,key},200,cors);
  }

  if(url.pathname==='/api/local/migration-status'&&request.method==='GET'){
    if(!localMigrationAllowed(request,env))return json({error:'forbidden_local_migration'},403,cors);
    const counts={};
    for(const table of Object.keys(MIGRATION_TABLES)){
      const row=await env.DB.prepare('SELECT COUNT(*) AS n FROM '+table).first();
      counts[table]=Number(row?.n||0);
    }
    const cfg=await env.DB.prepare('SELECT path,updated_at FROM local_config ORDER BY path').all();
    return json({ok:true,counts,configs:cfg.results||[],checked_at:new Date().toISOString()},200,cors);
  }

  if(url.pathname==='/api/ovh/agent/status'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_agent',ip:gate.ip},403,cors);}
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
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_agent',ip:gate.ip},403,cors);}
    const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit')||20)));
    const q=await env.DB.prepare(`SELECT id,payload_json,created_at FROM ovh_commands WHERE status='pending' OR (status='claimed' AND datetime(claimed_at)<datetime('now','-60 seconds')) ORDER BY created_at ASC LIMIT ?`).bind(limit).all();
    const commands=(q.results||[]).map(r=>{try{return JSON.parse(r.payload_json)}catch(_){return null}}).filter(Boolean);
    if(commands.length){
      const now=new Date().toISOString();
      for(const cmd of commands)await env.DB.prepare(`UPDATE ovh_commands SET status='claimed',claimed_at=? WHERE id=? AND status='pending'`).bind(now,String(cmd.id)).run();
    }
    return json({commands},200,cors);
  }
  if(url.pathname==='/api/ovh/agent/commands'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_agent',ip:gate.ip},403,cors);}
    const b=await bodyJson(request);
    const action=String(b.action||'').toLowerCase();
    const slot=String(b.runtime_slot||'');
    const allowedActions=new Set(['start','stop','update_playlist','set_playlist','set_visual','skip','previous','resume','restart']);
    if(!allowedActions.has(action))return json({error:'invalid_agent_command_action'},400,cors);
    if(!OVH_SLOTS.includes(slot))return json({error:'invalid_runtime_slot'},400,cors);
    const cmd=await issueOvhCommand(env,{...b,action,runtime_slot:slot,source:String(b.source||'github-oauth-bridge')});
    return json({ok:true,command:{id:cmd.id,action:cmd.action,runtime_slot:cmd.runtime_slot,requested_at:cmd.requested_at}},201,cors);
  }

  if(url.pathname==='/api/ovh/agent/command-ack'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_agent',ip:gate.ip},403,cors);}
    const b=await bodyJson(request),id=String(b.id||''),status=String(b.status||'completed'),now=new Date().toISOString();
    if(!id)return json({error:'id_required'},400,cors);
    await env.DB.prepare(`UPDATE ovh_commands SET status=?,completed_at=?,error=? WHERE id=?`).bind(status,now,String(b.error||''),id).run();
    return json({ok:true,id,status},200,cors);
  }

  if(url.pathname==='/api/ovh/deploy-agent/commands'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_deploy_agent',ip:gate.ip},403,cors);}
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
    const gate=ovhAgentAllowed(request,env);if(!gate.ok){await logOvhDenied(env,request,url.pathname);return json({error:'forbidden_deploy_agent',ip:gate.ip},403,cors);}
    const b=await bodyJson(request),id=String(b.id||''),status=String(b.status||'completed'),now=new Date().toISOString();
    if(!id)return json({error:'id_required'},400,cors);
    if(!['completed','failed'].includes(status))return json({error:'invalid_status'},400,cors);
    const result=b.result&&typeof b.result==='object'?b.result:{};
    await env.DB.prepare(`UPDATE ovh_deploy_commands SET status=?,completed_at=?,error=?,result_json=? WHERE id=?`).bind(status,now,String(b.error||''),JSON.stringify(result),id).run();
    return json({ok:true,id,status},200,cors);
  }

  if(url.pathname==='/api/auth/login'&&request.method==='POST'){const b=await bodyJson(request),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!env.ADMIN_EMAIL||!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return json({error:'auth_not_configured'},503,cors);if(email!==String(env.ADMIN_EMAIL).trim().toLowerCase()||password!==String(env.ADMIN_PASSWORD))return json({error:'invalid_credentials',message:'E-mail ou senha inválidos.'},401,cors);return json({ok:true,token:await signSession(email,env.SESSION_SECRET),user:{email,role:'admin'}},200,cors);}
  const djBridgeMatch=url.pathname.match(/^\/api\/dj-catalog\/bridge\/([^/]+)\/([^/]+)\/(manifest|results)$/);
  if(djBridgeMatch){
    const [,scanId,bridgeToken,op]=djBridgeMatch,row=await djScanRowByBridgeToken(env,scanId,bridgeToken);
    if(!row)return json({error:'invalid_or_expired_scan_token'},403,cors);
    if(op==='manifest'&&request.method==='GET'){
      const manifestPath=String(scanId).startsWith('dance100-')?'control/twitch-dj-candidates-2026-10-03.json':'control/gaming-reference-production/references.json';
      const refs=await fetchGithubJson(env,manifestPath),tracks=(refs?.tracks||[]).map(t=>({position:Number(t.position||0),spotify_id:String(t.spotify_id||''),title:String(t.title||''),artists:String(t.artists||'')})).filter(t=>t.position&&t.title);
      if(!tracks.length)return json({error:'reference_manifest_unavailable'},503,cors);
      return json({scan_id:scanId,total:tracks.length,playlist:refs?.playlist||null,tracks},200,cors);
    }
    if(op==='results'&&request.method==='POST'){
      const b=await bodyJson(request),items=Array.isArray(b.results)?b.results.slice(0,250):[];
      if(!items.length)return json({error:'results_required'},400,cors);
      const now=new Date().toISOString();
      for(const item of items){
        const pos=Number(item.position||0);if(!Number.isInteger(pos)||pos<1||pos>10000)continue;
        const status=djResultStatus(item.status),detail=item.detail&&typeof item.detail==='object'?item.detail:{};
        await env.DB.prepare(`INSERT INTO dj_catalog_results(scan_id,position,spotify_id,title,artists,status,matched_title,matched_artists,match_score,twitch_track_id,checked_at,detail_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(scan_id,position) DO UPDATE SET spotify_id=excluded.spotify_id,title=excluded.title,artists=excluded.artists,status=excluded.status,matched_title=excluded.matched_title,matched_artists=excluded.matched_artists,match_score=excluded.match_score,twitch_track_id=excluded.twitch_track_id,checked_at=excluded.checked_at,detail_json=excluded.detail_json`)
          .bind(scanId,pos,String(item.spotify_id||''),String(item.title||'').slice(0,300),String(item.artists||'').slice(0,500),status,String(item.matched_title||'').slice(0,300),String(item.matched_artists||'').slice(0,500),Number.isFinite(Number(item.match_score))?Number(item.match_score):null,String(item.twitch_track_id||'').slice(0,200),String(item.checked_at||now),JSON.stringify(detail).slice(0,20000)).run();
      }
      return json({ok:true,...await djRecount(env,scanId)},200,cors);
    }
  }

  if(url.pathname==='/api/ovh/public-health'&&request.method==='GET'){
    const state=await ovhState(env);
    if(!state)return json({runtime:'ovh',status:'unknown',services:{}},200,cors);
    const services={};
    for(const slot of OVH_SLOTS){
      const s=(state.services||{})[slot]||{};
      services[slot]={
        status:s.status||'unknown',
        updated_at:s.updated_at||null,
        fps:s.fps??null,
        video_bitrate_kbps:s.video_bitrate_kbps??null,
        restarts:Number(s.restarts||0),
        hot_swap:s.hot_swap===true,
        visual_revision:s.visual_revision??null,
        playlist_key:s.playlist_key||null,
        playlist_track_count:Number(s.playlist_track_count||0),
        dj_import:s.dj_import||null,
        now_playing:s.now_playing?{state:s.now_playing.state||null,track_id:s.now_playing.track_id||null,title:s.now_playing.title||null,started_at:s.now_playing.started_at||null}:null
      };
    }
    return json({runtime:'ovh',reported_at:state.reported_at||null,stored_at:state.stored_at||null,host:state.host?{load_1m:state.host.load_1m??null,memory_percent:state.host.memory_percent??null,disk_percent:state.host.disk_percent??null,uptime_seconds:state.host.uptime_seconds??null}:null,services},200,cors);
  }

  if(url.pathname==='/api/ops/20261003-live-stability/host-agent'&&request.method==='POST'){
    const id='ops-20261003-host-agent-v2',action='deploy_host_agent',target='host-agent',now=new Date().toISOString();
    const existing=await env.DB.prepare(`SELECT id,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands WHERE id=?`).bind(id).first();
    if(existing)return json({ok:true,command:{...existing,result:existing.result_json?JSON.parse(existing.result_json):null},deduplicated:true},200,cors);
    const payload={id,action,target,requested_at:now,requested_by:'ops-fixed-rollout',source:'20261003-live-stability'};
    await env.DB.prepare(`INSERT INTO ovh_deploy_commands(id,action,target,payload_json,status,created_at) VALUES(?,?,?,?, 'pending', ?)`).bind(id,action,target,JSON.stringify(payload),now).run();
    return json({ok:true,command:payload,status:'pending'},202,cors);
  }
  if(url.pathname==='/api/ops/20261003-live-stability/hot-patch'&&request.method==='POST'){
    const prerequisite=await env.DB.prepare(`SELECT status FROM ovh_deploy_commands WHERE id='ops-20261003-host-agent-v2'`).first();
    if(!prerequisite||prerequisite.status!=='completed')return json({error:'host_agent_not_ready',status:prerequisite?.status||'missing'},409,cors);
    const id='ops-20261003-hot-patch-v2',action='hot_patch_streaming',target='all',now=new Date().toISOString();
    const existing=await env.DB.prepare(`SELECT id,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands WHERE id=?`).bind(id).first();
    if(existing)return json({ok:true,command:{...existing,result:existing.result_json?JSON.parse(existing.result_json):null},deduplicated:true},200,cors);
    const payload={id,action,target,requested_at:now,requested_by:'ops-fixed-rollout',source:'20261003-live-stability'};
    await env.DB.prepare(`INSERT INTO ovh_deploy_commands(id,action,target,payload_json,status,created_at) VALUES(?,?,?,?, 'pending', ?)`).bind(id,action,target,JSON.stringify(payload),now).run();
    return json({ok:true,command:payload,status:'pending'},202,cors);
  }
  if(url.pathname==='/api/ops/20261003-live-stability/status'&&request.method==='GET'){
    const q=await env.DB.prepare(`SELECT id,action,target,status,created_at,claimed_at,completed_at,error,result_json FROM ovh_deploy_commands WHERE id IN ('ops-20261003-host-agent-v2','ops-20261003-hot-patch-v2') ORDER BY created_at`).all();
    return json({commands:(q.results||[]).map(r=>({...r,result:r.result_json?JSON.parse(r.result_json):null}))},200,cors);
  }
  if(url.pathname==='/api/ops/20261003-live-stability/restart-deep-house'&&request.method==='POST'){
    const state=await ovhState(env),svc=(state?.services||{})['youtube-deep-house']||{};
    const cmd=await issueOvhCommand(env,{
      id:'ops-20261003-restart-youtube-deep-house-v1',
      action:'restart',
      runtime_slot:'youtube-deep-house',
      platform:'youtube',
      session_id:String(svc.session_id||'8cf99db8-3e53-4b74-b9d2-51fb67b54ff8'),
      title:String(svc.title||'deep house radio 💻 music to work/study/focus to | Peter Lofi 🎧'),
      source:'incident-youtube-deep-house-recovery'
    });
    return json({ok:true,command:cmd},202,cors);
  }

  if(url.pathname==='/api/ovh/agent/music-jobs'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    if(String(env.LOCAL_RUNTIME||'')!=='1')return json({jobs:[]},200,cors);
    const row=await env.DB.prepare(`SELECT * FROM music_generation_jobs WHERE status='queued' OR (status='running' AND datetime(updated_at)<datetime('now','-15 minutes')) ORDER BY created_at ASC LIMIT 1`).first();
    if(!row)return json({jobs:[]},200,cors);
    const now=new Date().toISOString();
    await env.DB.prepare(`UPDATE music_generation_jobs SET status='running',progress=CASE WHEN progress<3 THEN 3 ELSE progress END,phase='Processando na OVH',updated_at=? WHERE id=?`).bind(now,row.id).run();
    return json({jobs:[{...row,status:'running',phase:'Processando na OVH',updated_at:now}]},200,cors);
  }
  if(url.pathname==='/api/ovh/agent/music-job-ack'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    const b=await bodyJson(request),id=String(b.id||''),status=String(b.status||'running');
    if(!id)return json({error:'id_required'},400,cors);
    if(!['running','completed','failed'].includes(status))return json({error:'invalid_status'},400,cors);
    const job=await env.DB.prepare(`SELECT * FROM music_generation_jobs WHERE id=?`).bind(id).first();if(!job)return json({error:'music_job_not_found'},404,cors);
    const progress=Math.max(0,Math.min(100,Number(b.progress??job.progress??0))),phase=String(b.phase||job.phase||''),err=String(b.error||''),now=new Date().toISOString(),completed=status==='completed'||status==='failed'?now:null,result=b.result&&typeof b.result==='object'?b.result:null;
    let playlist=null;
    if(status==='completed'&&result)playlist=await catalogGeneratedPlaylist(env,job,result);
    await env.DB.prepare(`UPDATE music_generation_jobs SET status=?,progress=?,phase=?,release_tag=NULL,master_audio_url=?,error=?,updated_at=?,completed_at=?,result_json=? WHERE id=?`).bind(status,progress,phase,result?.master_audio_url||job.master_audio_url||null,err||null,now,completed,result?JSON.stringify({...result,playlist}):job.result_json||null,id).run();
    return json({ok:true,id,status,progress,phase,playlist},200,cors);
  }
  if(url.pathname==='/api/ovh/agent/assets'&&request.method==='PUT'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    if(String(env.LOCAL_RUNTIME||'')!=='1')return json({error:'local_runtime_required'},409,cors);
    const name=safeName(url.searchParams.get('name')||'audio.bin'),title=String(url.searchParams.get('title')||name).slice(0,160),assetType=['audio','thumbnail','loop'].includes(String(url.searchParams.get('asset_type')))?String(url.searchParams.get('asset_type')):'audio',mime=String(request.headers.get('content-type')||'application/octet-stream'),size=Math.max(0,Number(request.headers.get('content-length')||0)),assetId=crypto.randomUUID(),token=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),day=new Date().toISOString().slice(0,10),key=`${assetType}/${day}/${assetId}-${name}`,now=new Date().toISOString();
    await env.MEDIA.put(key,request.body,{httpMetadata:{contentType:mime,cacheControl:'public, max-age=3600'}});
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(assetId,title,assetType,key,mime,size,'ready',token,JSON.stringify({source:'ovh-music-agent'}),now).run();
    const asset=await readAsset(env,assetId);
    return json({ok:true,asset:{id:asset.id,title:asset.title,asset_type:asset.asset_type,mime_type:asset.mime_type,size_bytes:asset.size_bytes,public_url:assetPublicUrl(request,asset,env),runtime_url:assetRuntimeUrl(request,asset,env)}},201,cors);
  }
  if(url.pathname==='/api/ovh/github-youtube-bootstrap'&&request.method==='POST'){
    let claims;
    try{claims=await verifyGithubActionsOidc(bearer(request));}
    catch(e){return json({error:'invalid_github_oidc',message:e?.message||String(e)},403,cors);}
    const b=await bodyJson(request);
    const slot=String(b.runtime_slot||'');
    if(slot!=='youtube-gta-vi')return json({error:'invalid_youtube_bootstrap_slot'},400,cors);
    const streamUrl=String(b.stream_url||'').trim(),streamKey=String(b.stream_key||'').trim();
    if(!streamUrl||!streamKey)return json({error:'youtube_ingest_required'},400,cors);
    const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)==='gta-vi-vice-city');
    if(!playlist)return json({error:'playlist_not_found'},404,cors);
    const tracks=(playlist.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({
      id:String(t.id||`gta-vi-vice-city-${i+1}`),
      title:String(t.title||'Track'),
      url:String(t.url),
      duration_seconds:Number(t.duration_seconds||300),
      position:t.position??null,
      target_bpm:t.target_bpm??null
    }));
    if(!tracks.length)return json({error:'playlist_empty'},400,cors);
    const cmd=await issueOvhCommand(env,{
      action:'start',
      platform:'youtube',
      runtime_slot:'youtube-gta-vi',
      session_id:String(b.session_id||''),
      title:String(b.title||'GTA VI - Vice City'),
      description:String(b.description||''),
      duration_minutes:0,
      loop_url:String(b.loop_url||''),
      playlist_key:'gta-vi-vice-city',
      tracks,
      shuffle:true,
      repeat:true,
      stream_url:streamUrl,
      stream_key:streamKey,
      source:'github-actions-oidc-youtube-bridge',
      github_run_id:String(claims.run_id||'')
    });
    return json({
      ok:true,
      authenticated_repository:claims.repository,
      runtime_slot:'youtube-gta-vi',
      playlist_key:'gta-vi-vice-city',
      playlist_track_count:tracks.length,
      command:{id:cmd.id,action:cmd.action,requested_at:cmd.requested_at}
    },202,cors);
  }

  if(url.pathname==='/api/ovh/agent/runtime-config'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    const path=String(url.searchParams.get('path')||'').trim();
    if(!['control/music-library.json','control/mediaforge-catalog.json','control/youtube-stations.json','config/peter_lofi_series.json','control/gaming-reference-production/references.json','control/twitch-dj-candidates-2026-10-03.json','control/twitch-dj-supplied-2026-10-03.json'].includes(path))return json({error:'config_path_not_allowed'},400,cors);
    const payload=await localConfigJson(env,path);
    if(url.searchParams.get('raw')==='1')return json(payload,payload===null?404:200,cors);
    return json({path,payload},payload===null?404:200,cors);
  }
  if(url.pathname==='/api/ovh/agent/runtime-config'&&request.method==='POST'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    const b=await bodyJson(request),path=String(b.path||'').trim(),payload=b.payload;
    if(!['control/music-library.json','control/mediaforge-catalog.json','control/youtube-stations.json','config/peter_lofi_series.json','control/gaming-reference-production/references.json','control/twitch-dj-candidates-2026-10-03.json','control/twitch-dj-supplied-2026-10-03.json'].includes(path))return json({error:'config_path_not_allowed'},400,cors);
    if(payload===undefined||payload===null)return json({error:'payload_required'},400,cors);
    await setLocalConfig(env,path,payload);
    return json({ok:true,path,updated_at:new Date().toISOString()},200,cors);
  }

  if(url.pathname==='/api/ovh/agent/operational-status'&&request.method==='GET'){
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    return json({local_runtime:String(env.LOCAL_RUNTIME||'')==='1',youtube_oauth:!!(env.YOUTUBE_CLIENT_ID&&env.YOUTUBE_CLIENT_SECRET&&env.YOUTUBE_REFRESH_TOKEN),youtube_channel:!!env.YOUTUBE_CHANNEL_ID,music_agent_credentials:'external-root-readable-env'},200,cors);
  }

  if(url.pathname==='/api/ovh/agent/youtube-github-bridge'&&request.method==='POST'){
    if(String(env.LOCAL_RUNTIME||'')==='1')return json({error:'bridge_remote_only'},409,cors);
    const gate=ovhAgentAllowed(request,env);if(!gate.ok)return json({error:'forbidden_agent',ip:gate.ip},403,cors);
    const b=await bodyJson(request);
    const sessionId=String(b.session_id||'').trim();
    const title=String(b.title||'').trim();
    const description=String(b.description||'');
    const loopUrl=String(b.loop_url||'').trim();
    const thumbnailUrl=String(b.thumbnail_url||'').trim();
    if(!sessionId||!title||!description||!loopUrl||!thumbnailUrl)return json({error:'bridge_payload_incomplete'},400,cors);
    const requestedAt=String(b.requested_at||new Date().toISOString());
    const launchPath=`control/gta-youtube-launch/${sessionId}.json`;
    try{
      await githubQueueFileToRepo(
        env,
        'thebusinessflowtv/theofficemusic',
        launchPath,
        {session_id:sessionId,title,description,loop_url:loopUrl,thumbnail_url:thumbnailUrl,requested_at:requestedAt,source:'mediaforge-ovh-remote-bridge'},
        `youtube: launch GTA VI OVH live ${sessionId}`
      );
    }catch(e){
      return json({error:'remote_github_bridge_failed',message:String(e?.message||e).slice(0,700)},502,cors);
    }
    return json({ok:true,queued:true,path:launchPath,mode:'remote-github-oauth-launch'},202,cors);
  }

  const session=await requireAuth(request,env);if(!session)return json({error:'unauthorized',message:'Sessão inválida ou expirada.'},401,cors);
  if(url.pathname==='/api/me'&&request.method==='GET')return json({user:{email:session.sub,role:'admin'}},200,cors);

  if(url.pathname==='/api/video/channels'&&request.method==='GET'){
    await ensureVideoFactorySchema(env);
    return json({channels:VIDEO_FACTORY_CHANNELS_V2},200,cors);
  }
  if(url.pathname==='/api/video/productions'&&request.method==='GET'){
    await ensureVideoFactorySchema(env);
    const channel=String(url.searchParams.get('channel')||'').trim(),status=String(url.searchParams.get('status')||'').trim();
    let sql='SELECT * FROM video_productions',where=[],args=[];
    if(channel){where.push('channel_slug=?');args.push(channel);}
    if(status){where.push('status=?');args.push(status);}
    if(where.length)sql+=' WHERE '+where.join(' AND ');
    sql+=' ORDER BY created_at DESC LIMIT 300';
    const q=await env.DB.prepare(sql).bind(...args).all();
    return json({productions:(q.results||[]).map(normalizeVideoFactoryRow)},200,cors);
  }
  if(url.pathname==='/api/video/productions'&&request.method==='POST'){
    const b=await bodyJson(request);
    try{return json({production:await createVideoFactoryProduction(env,b)},201,cors);}
    catch(e){return json({error:'video_production_create_failed',message:String(e?.message||e)},502,cors);}
  }
  const videoProdMatch=url.pathname.match(/^\/api\/video\/productions\/([^/]+)$/);
  if(videoProdMatch&&request.method==='GET'){
    const data=await getVideoFactoryProduction(env,decodeURIComponent(videoProdMatch[1]),url.searchParams.get('refresh')==='1');
    if(!data)return json({error:'video_production_not_found'},404,cors);
    return json(data,200,cors);
  }
  const videoRefreshMatch=url.pathname.match(/^\/api\/video\/productions\/([^/]+)\/refresh$/);
  if(videoRefreshMatch&&request.method==='POST'){
    const data=await getVideoFactoryProduction(env,decodeURIComponent(videoRefreshMatch[1]),true);
    if(!data)return json({error:'video_production_not_found'},404,cors);
    return json(data,200,cors);
  }
  const videoSuggestionsMatch=url.pathname.match(/^\/api\/video\/productions\/([^/]+)\/suggestions$/);
  if(videoSuggestionsMatch&&request.method==='GET'){
    try{return json(await getVideoFactorySuggestions(env,decodeURIComponent(videoSuggestionsMatch[1])),200,cors);}
    catch(e){return json({error:'video_suggestions_failed',message:String(e?.message||e)},502,cors);}
  }
  const videoSelectMatch=url.pathname.match(/^\/api\/video\/productions\/([^/]+)\/select-suggestion$/);
  if(videoSelectMatch&&request.method==='POST'){
    const b=await bodyJson(request);
    try{return json({production:await selectVideoFactorySuggestion(env,decodeURIComponent(videoSelectMatch[1]),b.index)},200,cors);}
    catch(e){return json({error:'video_suggestion_select_failed',message:String(e?.message||e)},502,cors);}
  }

  if(url.pathname==='/api/dj-catalog/scans'&&request.method==='POST'){
    const b=await bodyJson(request),source=String(b.source||'gaming').trim().toLowerCase();
    const manifests={
      gaming:'control/gaming-reference-production/references.json',
      dance100:'control/twitch-dj-candidates-2026-10-03.json'
    };
    const manifestPath=manifests[source];
    if(!manifestPath)return json({error:'invalid_dj_scan_source',message:'Fonte de verificação desconhecida.'},400,cors);
    const refs=await fetchGithubJson(env,manifestPath),total=Number((refs?.tracks||[]).length||0);
    if(!total)return json({error:'reference_manifest_unavailable',message:'A lista selecionada ainda não está disponível.'},503,cors);
    const prefix=source==='dance100'?'dance100-':'gaming-';
    const id=prefix+crypto.randomUUID(),bridgeToken=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),tokenHash=await sha256hex(bridgeToken),now=new Date(),created=now.toISOString(),expires=new Date(now.getTime()+6*60*60*1000).toISOString();
    await env.DB.prepare(`INSERT INTO dj_catalog_scans(id,token_hash,status,total,processed,allowed,restricted,not_found,ambiguous,error_count,created_at,updated_at,expires_at) VALUES(?,?,'pending',?,0,0,0,0,0,0,?,?,?)`).bind(id,tokenHash,total,created,created,expires).run();
    const origin=new URL(request.url).origin,launchUrl=`https://dashboard.twitch.tv/u/peterlofi/dj#mediaforge_scan=${encodeURIComponent(id)}&mediaforge_token=${encodeURIComponent(bridgeToken)}&mediaforge_api=${encodeURIComponent(origin)}`;
    return json({ok:true,source,playlist:refs?.playlist||null,scan:{id,status:'pending',total,processed:0,allowed:0,restricted:0,not_found:0,ambiguous:0,error_count:0,created_at:created,updated_at:created,expires_at:expires},launch_url:launchUrl,install_url:'https://thebusinessflowtv.github.io/thebusinessflow/control-center/twitch-dj-catalog-scanner.user.js'},200,cors);
  }
  if(url.pathname==='/api/dj-catalog/scans'&&request.method==='GET'){
    const limit=Math.max(1,Math.min(20,Number(url.searchParams.get('limit')||5))),q=await env.DB.prepare(`SELECT * FROM dj_catalog_scans ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    return json({scans:await Promise.all((q.results||[]).map(r=>djScanSummary(env,r,false)))},200,cors);
  }
  const djScanMatch=url.pathname.match(/^\/api\/dj-catalog\/scans\/([^/]+)$/);
  if(djScanMatch&&request.method==='GET'){
    const row=await env.DB.prepare(`SELECT * FROM dj_catalog_scans WHERE id=?`).bind(djScanMatch[1]).first();
    if(!row)return json({error:'dj_scan_not_found'},404,cors);
    return json({scan:await djScanSummary(env,row,true)},200,cors);
  }
  const djAudioMatch=url.pathname.match(/^\/api\/dj-catalog\/scans\/([^/]+)\/audio-source$/);
  if(djAudioMatch&&request.method==='POST'){
    const scanId=djAudioMatch[1],b=await bodyJson(request),position=Number(b.position||0),assetId=String(b.asset_id||''),source=String(b.acquisition_source||'').trim(),note=String(b.acquisition_note||'').trim();
    if(!Number.isInteger(position)||position<1)return json({error:'invalid_position'},400,cors);
    const result=await env.DB.prepare(`SELECT * FROM dj_catalog_results WHERE scan_id=? AND position=?`).bind(scanId,position).first();
    if(!result)return json({error:'dj_result_not_found'},404,cors);
    if(String(result.status)!=='allowed')return json({error:'track_not_allowed',message:'Somente faixas Allowed podem receber fonte de áudio para o modo DJ.'},409,cors);
    const asset=await readAsset(env,assetId);
    if(!asset||asset.status!=='ready')return json({error:'audio_asset_not_ready'},404,cors);
    if(asset.asset_type!=='audio'||!String(asset.mime_type||'').startsWith('audio/'))return json({error:'audio_asset_invalid_type'},400,cors);
    const now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO dj_catalog_audio_sources(scan_id,position,asset_id,acquisition_source,acquisition_note,verified_owned,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?)
      ON CONFLICT(scan_id,position) DO UPDATE SET asset_id=excluded.asset_id,acquisition_source=excluded.acquisition_source,acquisition_note=excluded.acquisition_note,verified_owned=1,updated_at=excluded.updated_at`)
      .bind(scanId,position,assetId,source||'user_licensed_copy',note,now,now).run();
    return json({ok:true,scan_id:scanId,position,asset:{id:asset.id,title:asset.title,public_url:assetPublicUrl(request,asset)}},200,cors);
  }

  const djMixedMatch=url.pathname.match(/^\/api\/dj-catalog\/scans\/([^/]+)\/mixed-playlist$/);
  if(djMixedMatch&&request.method==='GET'){
    const scanId=djMixedMatch[1],library=await getMusicLibrary(env),gaming=(library.playlists||[]).find(p=>String(p.key)==='gaming-radio');
    const original=(gaming?.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({id:String(t.id||`gaming-radio-${i+1}`),title:String(t.title||'Track'),artists:'Peter Lofi',url:String(t.url),duration_seconds:Number(t.duration_seconds||0),source:'peter_lofi_original',dj_catalog_required:false}));
    const q=await env.DB.prepare(`SELECT r.position,r.spotify_id,r.title,r.artists,r.matched_title,r.matched_artists,r.checked_at,s.asset_id,a.title AS asset_title,a.mime_type,a.status AS asset_status,a.download_token
      FROM dj_catalog_results r
      JOIN dj_catalog_audio_sources s ON s.scan_id=r.scan_id AND s.position=r.position AND s.verified_owned=1
      JOIN assets a ON a.id=s.asset_id
      WHERE r.scan_id=? AND r.status='allowed' AND a.status='ready' AND a.asset_type='audio'
      ORDER BY r.position`).bind(scanId).all();
    const allowed=(q.results||[]).map(r=>({id:`twitch-dj-${scanId}-${r.position}`,title:String(r.matched_title||r.title||r.asset_title||'DJ Track'),artists:String(r.matched_artists||r.artists||''),url:`${new URL(request.url).origin}/media/${r.asset_id}/${r.download_token}`,duration_seconds:0,source:'twitch_dj_catalog_licensed_copy',dj_catalog_required:true,dj_scan_id:scanId,dj_position:Number(r.position),catalog_checked_at:r.checked_at}));
    const mixed=[];let i=0,j=0;
    while(i<original.length||j<allowed.length){if(i<original.length)mixed.push(original[i++]);if(j<allowed.length)mixed.push(allowed[j++]);}
    const scan=await env.DB.prepare(`SELECT * FROM dj_catalog_scans WHERE id=?`).bind(scanId).first();
    const pending=await env.DB.prepare(`SELECT COUNT(*) AS n FROM dj_catalog_results r LEFT JOIN dj_catalog_audio_sources s ON s.scan_id=r.scan_id AND s.position=r.position AND s.verified_owned=1 WHERE r.scan_id=? AND r.status='allowed' AND s.asset_id IS NULL`).bind(scanId).first();
    return json({playlist:{key:'twitch-dj-mixed',name:'Twitch DJ Mixed',platform:'twitch',mode:'live_interactive_dj_performance_only',automated_radio_allowed:false,shuffle:true,repeat:false,original_count:original.length,dj_allowed_with_audio_count:allowed.length,dj_allowed_missing_audio_count:Number(pending?.n||0),track_count:mixed.length,tracks:mixed},scan:scan?await djScanSummary(env,scan,false):null},200,cors);
  }
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
      if(String(env.LOCAL_RUNTIME||'')!=='1')await githubDispatchWorkflow(env,'peter-lofi-generate-playlist.yml',{request_id:id,series_key:seriesKey,playlist_name:name,duration_minutes:String(duration)});
      return json({ok:true,job:{id,series_key:seriesKey,playlist_name:name,duration_minutes:duration,status:'queued',progress:0,phase:String(env.LOCAL_RUNTIME||'')==='1'?'Na fila da OVH':'Na fila',created_at:now},execution:String(env.LOCAL_RUNTIME||'')==='1'?'ovh-local':'github-actions'},200,cors);
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
    if(action==='hot_patch_streaming')target=(target==='all'||OVH_SLOTS.includes(target))?target:'all';
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
  if(url.pathname==='/api/music-library/gaming-dj30'&&request.method==='POST'){
    const b=await bodyJson(request);
    try{return json(await appendGamingDj30Assets(env,request,b.tracks,assetPublicUrl),200,cors);}
    catch(e){return json({error:e.message||'gaming_append_failed'},400,cors);}
  }
  // Admin-authenticated, Lofi-only import into the OVH-local music selector.
  // Never modifies a live session, slot, encoder or unrelated playlist.
  if(url.pathname==='/api/music-library/lofi-hip-hop-sync'&&request.method==='POST'){
    if(String(env.LOCAL_RUNTIME||'')!=='1')return json({error:'ovh_local_only'},409,cors);
    const input=(await bodyJson(request)).playlist;
    if(!input||input.key!=='lofi-hip-hop'||!Array.isArray(input.tracks)||input.tracks.length<1||input.tracks.length>36)
      return json({error:'invalid_lofi_catalog'},400,cors);
    const ids=new Set(),validated=[];
    for(const t of input.tracks){
      const id=String(t?.id||''),url=String(t?.url||'');
      if(!/^lofi-hip-hop-20261008-\d{2}$/.test(id)||ids.has(id)||
         !url.startsWith('https://github.com/thebusinessflowtv/theofficemusic/releases/download/peter-lofi-lofi-hip-hop-')||
         Number(t.duration_seconds)!==300||t.quality_gate!=='technical_and_45s_intro_diversity_passed')
        return json({error:'unapproved_or_duplicate_lofi_track',id},400,cors);
      ids.add(id);
      validated.push({...t,id,url,title:String(t.title||id).slice(0,150),duration_seconds:300});
    }
    const current=await getMusicLibrary(env);
    if(!Array.isArray(current?.playlists))return json({error:'invalid_ovh_music_library'},409,cors);
    const prior=current.playlists.find(p=>p?.key==='lofi-hip-hop')||null;
    const oldTracks=Array.isArray(prior?.tracks)?prior.tracks:[];
    const all=new Map();
    for(const t of oldTracks)if(t?.id&&t?.url)all.set(String(t.id),t);
    for(const t of validated){
      const old=all.get(t.id);
      // Do not replace an already localized file with a GitHub URL.
      all.set(t.id,old?.asset_id&&old?.url?{...t,url:old.url,asset_id:old.asset_id}:t);
    }
    const tracks=[...all.values()].sort((a,b)=>Number(a.position||999)-Number(b.position||999));
    const library={...current,updated_at:new Date().toISOString(),
      playlists:[...current.playlists.filter(p=>p?.key!=='lofi-hip-hop'),{
        ...(prior||{}),...input,key:'lofi-hip-hop',name:'Lofi Hip Hop',
        tracks,track_count:tracks.length,total_duration_seconds:tracks.reduce((sum,t)=>sum+Number(t.duration_seconds||0),0),
        status:tracks.length>=36?'complete':'generating'
      }]};
    if(!prior||JSON.stringify(prior.tracks)!==JSON.stringify(tracks))
      await setLocalConfig(env,'control/music-library.json',library);
    return json({ok:true,playlist_key:'lofi-hip-hop',track_count:tracks.length,
      other_playlists_preserved:current.playlists.length-(prior?1:0),rtmp_restart:false},200,cors);
  }

  if(url.pathname==='/api/music-library'&&request.method==='GET'){
    const library=await getMusicLibrary(env);
    return json(library,200,cors);
  }
  if(url.pathname==='/api/twitch-dj/import-archive'&&request.method==='POST'){
    const b=await bodyJson(request),assetId=String(b.asset_id||''),mode=String(b.mode||'legacy').toLowerCase();
    const asset=await readAsset(env,assetId);
    if(!asset||asset.status!=='ready')return json({error:'dj_archive_not_ready'},404,cors);
    if(asset.asset_type!=='dj_archive')return json({error:'invalid_dj_archive_type'},400,cors);

    const state=await ovhState(env),twitch=state?.services?.twitch||{},kick=state?.services?.kick||{};
    if(twitch.hot_swap!==true)return json({error:'twitch_hot_swap_not_ready',message:'Importação bloqueada para proteger a live: Twitch ainda não confirmou hot-swap.'},409,cors);

    if(mode==='shared_commercial_replace'){
      if(kick.hot_swap!==true)return json({error:'kick_hot_swap_not_ready',message:'Importação bloqueada para proteger a live: Kick ainda não confirmou hot-swap.'},409,cors);
      const cmd=await issueOvhCommand(env,{
        action:'import_shared_dj_archive',
        runtime_slot:'twitch',
        platform:'twitch',
        session_id:String(twitch.session_id||''),
        title:String(twitch.title||''),
        archive_asset_id:asset.id,
        archive_url:assetRuntimeUrl(request,asset,env),
        expected_original_tracks:36,
        shuffle:true,
        repeat:true,
        source:'mediaforge-shared-dj-batch-import'
      });
      return json({
        ok:true,
        mode:'shared_commercial_replace',
        rtmp_restart:false,
        container_restart:false,
        safety_order:['audit_zip','stage_new_tracks_with_originals','validate_stage','remove_36_originals','sync_independent_kick_playlist'],
        asset:{id:asset.id,title:asset.title,size_bytes:asset.size_bytes},
        command:cmd
      },202,cors);
    }

    const manifest=await fetchGithubJson(env,'control/twitch-dj-supplied-2026-10-03.json');
    if(!manifest||!Array.isArray(manifest.tracks)||!manifest.tracks.length)return json({error:'dj_manifest_unavailable'},503,cors);
    const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)==='twitch-dj-mixed');
    if(!playlist)return json({error:'twitch_dj_playlist_missing'},503,cors);
    const allowedPlatforms=Array.isArray(playlist.allowed_platforms)?playlist.allowed_platforms.map(x=>String(x).toLowerCase()):[];
    if(!allowedPlatforms.includes('twitch')||allowedPlatforms.some(x=>x!=='twitch'))return json({error:'twitch_dj_platform_lock_invalid'},409,cors);
    const baseTracks=(playlist.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({id:String(t.id||`twitch-dj-original-${i+1}`),title:String(t.title||'Peter Lofi'),url:String(t.url),duration_seconds:Number(t.duration_seconds||0),source:'peter_lofi_original'}));
    const cmd=await issueOvhCommand(env,{action:'import_twitch_dj_archive',runtime_slot:'twitch',platform:'twitch',session_id:String(twitch.session_id||''),title:String(twitch.title||''),playlist_key:'twitch-dj-mixed',archive_asset_id:asset.id,archive_url:assetRuntimeUrl(request,asset,env),manifest:String(env.LOCAL_RUNTIME||'')==='1'?manifest:undefined,manifest_url:String(env.LOCAL_RUNTIME||'')==='1'?(String(env.OVH_INTERNAL_API_URL||'http://host.docker.internal:8790').replace(/\/$/,'')+'/api/ovh/agent/runtime-config?path='+encodeURIComponent('control/twitch-dj-supplied-2026-10-03.json')+'&raw=1'):'https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/twitch-dj-supplied-2026-10-03.json',base_tracks:baseTracks,shuffle:true,repeat:true,source:'mediaforge-twitch-dj-import'});
    return json({ok:true,mode:'twitch_only_hot_import',rtmp_restart:false,asset:{id:asset.id,title:asset.title,size_bytes:asset.size_bytes},expected_unique_tracks:Number(manifest.unique_audio_files||manifest.tracks.length),command:cmd},202,cors);
  }

  if(url.pathname==='/api/twitch-dj/status'&&request.method==='GET'){
    const state=await ovhState(env),svc=state?.services?.twitch||{},kick=state?.services?.kick||{};
    return json({
      playlist_key:String(svc.playlist_key||''),
      playlist_track_count:Number(svc.playlist_track_count||0),
      dj_import:svc.dj_import||null,
      status:String(svc.status||'unknown'),
      hot_swap:svc.hot_swap===true,
      now_playing:svc.now_playing||null,
      kick:{
        playlist_key:String(kick.playlist_key||''),
        playlist_track_count:Number(kick.playlist_track_count||0),
        status:String(kick.status||'unknown'),
        hot_swap:kick.hot_swap===true,
        dj_import:kick.dj_import||null
      }
    },200,cors);
  }

  if(url.pathname==='/api/ovh/youtube-bootstrap'&&request.method==='POST'){
    const b=await bodyJson(request);
    const slot=String(b.runtime_slot||'');
    if(slot!=='youtube-gta-vi')return json({error:'invalid_youtube_bootstrap_slot'},400,cors);
    const streamUrl=String(b.stream_url||'').trim(),streamKey=String(b.stream_key||'').trim();
    if(!streamUrl||!streamKey)return json({error:'youtube_ingest_required'},400,cors);
    const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)==='gta-vi-vice-city');
    if(!playlist)return json({error:'playlist_not_found'},404,cors);
    const tracks=(playlist.tracks||[]).filter(t=>t&&t.url).map((t,i)=>({
      id:String(t.id||`gta-vi-vice-city-${i+1}`),
      title:String(t.title||'Track'),
      url:String(t.url),
      duration_seconds:Number(t.duration_seconds||300),
      position:t.position??null,
      target_bpm:t.target_bpm??null
    }));
    if(!tracks.length)return json({error:'playlist_empty'},400,cors);
    const cmd=await issueOvhCommand(env,{
      action:'start',
      platform:'youtube',
      runtime_slot:'youtube-gta-vi',
      session_id:String(b.session_id||''),
      title:String(b.title||'GTA VI - Vice City'),
      description:String(b.description||''),
      duration_minutes:0,
      loop_url:String(b.loop_url||''),
      playlist_key:'gta-vi-vice-city',
      tracks,
      shuffle:true,
      repeat:true,
      stream_url:streamUrl,
      stream_key:streamKey,
      source:'github-youtube-oauth-bridge'
    });
    return json({
      ok:true,
      runtime_slot:'youtube-gta-vi',
      playlist_key:'gta-vi-vice-city',
      playlist_track_count:tracks.length,
      command:{id:cmd.id,action:cmd.action,requested_at:cmd.requested_at}
    },202,cors);
  }

  if(url.pathname==='/api/ovh/playlist'&&request.method==='POST'){
    const b=await bodyJson(request),slot=String(b.runtime_slot||''),playlistKey=String(b.playlist_key||'');
    if(!OVH_SLOTS.includes(slot))return json({error:'invalid_runtime_slot'},400,cors);
    const library=await getMusicLibrary(env),playlist=(library.playlists||[]).find(p=>String(p.key)===playlistKey);
    if(!playlist)return json({error:'playlist_not_found',message:'Playlist não encontrada no catálogo Peter Lofi.'},404,cors);
    const slotPlatform=mapPlatformFromSlot(slot),allowedPlatforms=Array.isArray(playlist.allowed_platforms)?playlist.allowed_platforms.map(x=>String(x).toLowerCase()):[];
    if(allowedPlatforms.length&&!allowedPlatforms.includes(slotPlatform))return json({error:'playlist_platform_blocked',message:'Esta playlist é exclusiva da Twitch e não pode ser aplicada nesta plataforma.',playlist_key:playlistKey,platform:slotPlatform},409,cors);
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
      if(String(env.LOCAL_RUNTIME||'')==='1'){
        const stopped=await stopYoutubeLocal(env,{sessionId,slot,title:String(svc.title||'')});
        await env.DB.prepare(`UPDATE live_sessions SET status='stopping' WHERE id=?`).bind(sessionId).run().catch(()=>{});
        return json({ok:true,action:'stop',runtime_slot:slot,session_id:sessionId,mode:'youtube-ovh-local',command:stopped.command},200,cors);
      }
      await githubDispatchWorkflow(env,'mediaforge-youtube-ovh-stop.yml',{session_id:sessionId,runtime_slot:slot});
      return json({ok:true,action:'stop',runtime_slot:slot,session_id:sessionId,mode:'youtube-controlled-stop'},200,cors);
    }
    const cmd=await issueOvhCommand(env,{action,runtime_slot:slot,platform:mapPlatformFromSlot(slot),session_id:sessionId,title:String(b.title||svc.title||''),loop_url:String(b.loop_url||''),source:'mediaforge-ovh-panel'});
    return json({ok:true,command:cmd},200,cors);
  }

  const ovhControlStatusMatch=url.pathname.match(/^\/api\/ovh\/control\/([^/]+)$/);
  if(ovhControlStatusMatch&&request.method==='GET'){
    const row=await env.DB.prepare(`SELECT id,runtime_slot,action,status,created_at,claimed_at,completed_at,error FROM ovh_commands WHERE id=?`).bind(ovhControlStatusMatch[1]).first();
    if(!row)return json({error:'ovh_command_not_found'},404,cors);
    return json({command:row},200,cors);
  }

  if(url.pathname==='/api/ovh/visual'&&request.method==='POST'){
    const b=await bodyJson(request),slot=String(b.runtime_slot||''),assetId=String(b.asset_id||''),directUrl=String(b.loop_url||'').trim();
    if(!OVH_SLOTS.includes(slot))return json({error:'invalid_runtime_slot'},400,cors);
    let loopUrl=directUrl,asset=null;
    if(assetId){
      asset=await readAsset(env,assetId);
      if(!asset||asset.status!=='ready')return json({error:'visual_asset_not_ready'},404,cors);
      if(asset.asset_type!=='loop')return json({error:'visual_asset_invalid_type'},400,cors);
      loopUrl=assetRuntimeUrl(request,asset,env);
    }
    if(!loopUrl)return json({error:'loop_url_required',message:'Selecione ou envie um vídeo antes de aplicar.'},400,cors);
    const state=await ovhState(env),svc=state?.services?.[slot]||{},sessionId=String(b.session_id||svc.session_id||'');
    if(svc.hot_swap!==true){
      return json({error:'hot_swap_not_ready',message:'Troca bloqueada para proteger esta live: o runtime ainda não confirmou hot-swap persistente. O vídeo atual continua sem reiniciar a transmissão.',runtime_slot:slot},409,cors);
    }
    const cmd=await issueOvhCommand(env,{action:'set_visual',runtime_slot:slot,platform:mapPlatformFromSlot(slot),session_id:sessionId,title:String(svc.title||''),loop_url:loopUrl,asset_id:assetId||null,source:'mediaforge-visual-switch'});
    if(sessionId&&assetId){
      try{await env.DB.prepare(`INSERT OR REPLACE INTO live_session_assets(session_id,role,asset_id) VALUES(?,?,?)`).bind(sessionId,'visual',assetId).run();}catch(_){}
    }
    return json({ok:true,visual:{asset_id:assetId||null,title:asset?.title||null,loop_url:loopUrl},command:cmd},200,cors);
  }

  if(url.pathname==='/api/catalog'&&request.method==='GET')try{const catalog=await getCatalog(env),assets=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();return json({...catalog,assets:(assets.results||[]).map(a=>({id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,metadata:JSON.parse(a.metadata_json||'{}'),public_url:assetPublicUrl(request,a)}))},200,cors);}catch(e){return json({error:'catalog_error',message:e.message},502,cors);}
  if(url.pathname==='/api/assets'&&request.method==='GET'){const q=await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();return json({assets:(q.results||[]).map(a=>({id:a.id,title:a.title,asset_type:a.asset_type,mime_type:a.mime_type,size_bytes:a.size_bytes,created_at:a.created_at,metadata:JSON.parse(a.metadata_json||'{}'),public_url:assetPublicUrl(request,a)}))},200,cors);}

  if(url.pathname==='/api/uploads/init'&&request.method==='POST'){
    const b=await bodyJson(request),name=safeName(b.name),mime=String(b.mime_type||'application/octet-stream'),size=Math.max(0,Number(b.size_bytes||0)),assetId=crypto.randomUUID(),token=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''),day=new Date().toISOString().slice(0,10),assetType=['thumbnail','loop','audio','dj_archive'].includes(String(b.asset_type))?String(b.asset_type):'loop',key=`${assetType==='thumbnail'?'thumb':assetType==='audio'?'audio':assetType==='dj_archive'?'twitch-dj':'live'}/${day}/${assetId}-${name}`,upload=await env.MEDIA.createMultipartUpload(key,{httpMetadata:{contentType:mime}}),now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(assetId,b.title||b.name||name,assetType,key,mime,size,'uploading',token,JSON.stringify({live_visual:assetType==='loop',youtube_thumbnail:assetType==='thumbnail',dj_audio:assetType==='audio',twitch_dj_archive:assetType==='dj_archive',platform_lock:assetType==='dj_archive'?['twitch']:null,loop_forever:assetType==='loop',source:'r2_upload'}),now).run();
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
        const allowedPlatforms=Array.isArray(playlist.allowed_platforms)?playlist.allowed_platforms.map(x=>String(x).toLowerCase()):[];
        if(allowedPlatforms.length&&!allowedPlatforms.includes(platform))return json({error:'playlist_platform_blocked',message:'Esta playlist é exclusiva da Twitch e não pode ser iniciada nesta plataforma.',playlist_key:playlistKey,platform},409,cors);
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
      if(visualId){const a=await readAsset(env,visualId);if(!a||a.status!=='ready')return json({error:'visual_not_ready'},400,cors);visualUrl=assetRuntimeUrl(request,a,env);}
      if(thumbId){const a=await readAsset(env,thumbId);if(!a||a.status!=='ready'||!String(a.mime_type||'').startsWith('image/'))return json({error:'thumbnail_not_ready',message:'A thumbnail do YouTube precisa ser uma imagem pronta.'},400,cors);thumbnailUrl=String(env.LOCAL_RUNTIME||'')==='1'?assetRuntimeUrl(request,a,env):assetPublicUrl(request,a,env);}
      const id=crypto.randomUUID(),title=String(b.title||'Peter Lofi — Live').trim()||'Peter Lofi — Live',description=String(b.description||''),duration=Math.max(0,Math.min(10080,Number(b.duration_minutes??0)||0)),now=new Date().toISOString();
      let slot=platform;
      if(platform==='youtube'){
        slot=String(b.youtube_slot||'');
        if(!['youtube-deep-house','youtube-rainy','youtube-gta-vi'].includes(slot))return json({error:'youtube_slot_required',message:'Selecione um slot OVH do YouTube.'},400,cors);
        const cfg=await getYoutubeStations(env),st=(cfg.stations||[]).find(x=>String(x.ovh_slot||'')===slot);
        if(!st)return json({error:'youtube_slot_not_configured'},409,cors);
        if(!st.youtube_stream_id&&slot!=='youtube-gta-vi')return json({error:'youtube_slot_not_configured'},409,cors);
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
        if(String(env.LOCAL_RUNTIME||'')==='1'){
          if(slot==='youtube-gta-vi'){
            const bridgeUrl='https://mediaforge-api.guilhermeodsgn.workers.dev/api/ovh/agent/youtube-github-bridge';
            const bridgePayload={
              session_id:id,
              title,
              description,
              loop_url:visualUrl,
              thumbnail_url:thumbnailUrl,
              requested_at:now,
              source:'mediaforge-gta-secure-panel'
            };
            const bridgeRes=await fetch(bridgeUrl,{
              method:'POST',
              headers:{'content-type':'application/json','user-agent':'MediaForge-OVH-GTA-Bridge/1.0'},
              body:JSON.stringify(bridgePayload)
            });
            const bridgeText=await bridgeRes.text();
            let bridgeData={};try{bridgeData=JSON.parse(bridgeText||'{}')}catch(_){}
            if(!bridgeRes.ok)throw new Error(`Bridge remoto GitHub falhou (${bridgeRes.status}): ${String(bridgeData.error||bridgeText).slice(0,300)}`);
            return json({ok:true,launch_mode:'github-secure-gta-bridge',message:'OAuth fica no GitHub; a OVH recebe apenas o ingest temporário.',bridge:bridgeData,session:{id,platform,status:'starting',runtime:'ovh',runtime_slot:slot,title,description,duration_minutes:duration,track_ids:trackIds,created_at:now}},202,cors);
          }
          const local=await prepareYoutubeLocal(request,env,{sessionId:id,slot,title,description,thumbnailUrl,durationMinutes:duration,loopUrl:visualUrl,tracks:manifest,playlistKey});
          return json({ok:true,launch_mode:'ovh-youtube-local',youtube:local.result,command_id:local.command.id,session:{id,platform,status:'starting',runtime:'ovh',runtime_slot:slot,title,description,duration_minutes:duration,track_ids:trackIds,created_at:now}},200,cors);
        }
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
        if(String(env.LOCAL_RUNTIME||'')==='1')await stopYoutubeLocal(env,{sessionId:id,slot:String(slot||''),title:row.title});
        else await githubDispatchWorkflow(env,'mediaforge-youtube-ovh-stop.yml',{session_id:id,runtime_slot:String(slot||'')});
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
