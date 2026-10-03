// ==UserScript==
// @name         MediaForge — Twitch DJ Catalog Scanner
// @namespace    https://thebusinessflowtv.github.io/thebusinessflow/
// @version      1.0.2
// @description  Verifica automaticamente uma lista MediaForge no Twitch DJ Music Catalog autenticado, sem enviar cookies/OAuth da Twitch ao MediaForge.
// @match        https://dashboard.twitch.tv/u/*/dj*
// @match        https://www.twitch.tv/dj-signup*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function(){
  'use strict';

  const DEFAULT_API='https://mediaforge-api.guilhermeodsgn.workers.dev';
  const GQL='https://gql.twitch.tv/gql';
  const originalFetch=window.fetch.bind(window);
  const captured={headers:{},version:null,sha256Hash:null};
  let running=false,ui=null;

  function parseBridge(){
    const hash=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
    const fromHash={
      scan:hash.get('mediaforge_scan')||'',
      token:hash.get('mediaforge_token')||'',
      api:hash.get('mediaforge_api')||''
    };
    if(fromHash.scan&&fromHash.token){
      sessionStorage.setItem('mf_dj_scan',fromHash.scan);
      sessionStorage.setItem('mf_dj_token',fromHash.token);
      sessionStorage.setItem('mf_dj_api',fromHash.api||DEFAULT_API);
      try{history.replaceState(null,'',location.pathname+location.search)}catch(_){}
    }
    return {
      scan:fromHash.scan||sessionStorage.getItem('mf_dj_scan')||'',
      token:fromHash.token||sessionStorage.getItem('mf_dj_token')||'',
      api:(fromHash.api||sessionStorage.getItem('mf_dj_api')||DEFAULT_API).replace(/\/$/,'')
    };
  }

  const bridge=parseBridge();

  function headerMap(input){
    const out={};
    try{
      if(input instanceof Headers) input.forEach((v,k)=>out[k.toLowerCase()]=v);
      else if(Array.isArray(input)) for(const [k,v] of input)out[String(k).toLowerCase()]=String(v);
      else if(input&&typeof input==='object')for(const [k,v] of Object.entries(input))out[String(k).toLowerCase()]=String(v);
    }catch(_){}
    return out;
  }

  function captureRequest(resource,init){
    try{
      const url=typeof resource==='string'?resource:String(resource?.url||'');
      if(!url.includes('gql.twitch.tv/gql')||!init)return;
      const hm=headerMap(init.headers);
      for(const key of ['authorization','client-id','client-integrity','client-session-id','client-version','x-device-id']){
        if(hm[key])captured.headers[key]=hm[key];
      }
      let body=init.body;
      if(typeof body!=='string')return;
      const parsed=JSON.parse(body),ops=Array.isArray(parsed)?parsed:[parsed];
      const op=ops.find(x=>x?.operationName==='DJMusicCatalogSearchQuery');
      if(!op)return;
      const pq=op?.extensions?.persistedQuery;
      if(pq?.sha256Hash)captured.sha256Hash=pq.sha256Hash;
      if(pq?.version!=null)captured.version=pq.version;
      updateUI();
      maybeStart();
    }catch(_){}
  }

  window.fetch=async function(resource,init){
    captureRequest(resource,init);
    return originalFetch(resource,init);
  };

  function ready(){
    const h=captured.headers;
    return !!(bridge.scan&&bridge.token&&captured.sha256Hash&&captured.version!=null&&
      h['authorization']&&h['client-id']&&h['client-integrity']&&h['client-session-id']&&h['client-version']&&h['x-device-id']);
  }

  function norm(v){
    return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      .replace(/\b(feat|ft|featuring)\.?\b/g,' ')
      .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  }
  function tokens(v){return new Set(norm(v).split(' ').filter(Boolean));}
  function similarity(a,b){
    const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
    let hit=0;for(const x of A)if(B.has(x))hit++;
    return (2*hit)/(A.size+B.size);
  }
  function stringValue(o,keys){
    for(const k of keys){
      const v=o?.[k];
      if(typeof v==='string'&&v.trim())return v.trim();
      if(Array.isArray(v)){
        const arr=v.map(x=>typeof x==='string'?x:(x?.name||x?.displayName||x?.title||'')).filter(Boolean);
        if(arr.length)return arr.join(', ');
      }
      if(v&&typeof v==='object'&&typeof v.name==='string')return v.name;
    }
    return '';
  }
  function primitiveStatus(key,value){
    const k=String(key||'').toLowerCase(),s=String(value??'').toLowerCase().trim();
    if(typeof value==='boolean'&&(k.includes('allow')||k.includes('permit')||k.includes('playable')||k.includes('eligible')))return value?'allowed':'restricted';
    if(typeof value==='string'){
      if(/(^|[_\\s-])(restricted|blocked|disallowed|not[_\\s-]?allowed|not[_\\s-]?permitted|ineligible)([_\\s-]|$)/i.test(s))return 'restricted';
      if(/(^|[_\\s-])(allowed|permitted|allowlisted|eligible)([_\\s-]|$)/i.test(s))return 'allowed';
    }
    return '';
  }
  function statusFromObject(o,depth=0){
    if(!o||typeof o!=='object'||depth>4)return '';
    for(const [k,v] of Object.entries(o)){
      const direct=primitiveStatus(k,v);if(direct)return direct;
    }
    for(const v of Object.values(o)){
      if(v&&typeof v==='object'){
        const nested=statusFromObject(v,depth+1);if(nested)return nested;
      }
    }
    return '';
  }
  function deepStringByKeys(o,keys,depth=0){
    if(!o||typeof o!=='object'||depth>4)return '';
    const wanted=new Set(keys.map(x=>x.toLowerCase()));
    for(const [k,v] of Object.entries(o)){
      if(wanted.has(String(k).toLowerCase())){
        if(typeof v==='string'&&v.trim())return v.trim();
        if(Array.isArray(v)){
          const arr=v.map(x=>typeof x==='string'?x:(x?.name||x?.displayName||x?.title||'')).filter(Boolean);
          if(arr.length)return arr.join(', ');
        }
        if(v&&typeof v==='object'){
          const n=v.name||v.displayName||v.title||v.trackName;
          if(typeof n==='string'&&n.trim())return n.trim();
        }
      }
    }
    for(const v of Object.values(o)){
      if(v&&typeof v==='object'){
        const nested=deepStringByKeys(v,keys,depth+1);if(nested)return nested;
      }
    }
    return '';
  }
  function collectObjects(value,out=[],depth=0){
    if(depth>8||out.length>1200||value==null)return out;
    if(Array.isArray(value)){for(const x of value)collectObjects(x,out,depth+1);return out;}
    if(typeof value==='object'){
      out.push(value);
      for(const x of Object.values(value))if(x&&typeof x==='object')collectObjects(x,out,depth+1);
    }
    return out;
  }
  function compactShape(result){
    try{
      const objects=collectObjects(result,[]);
      return objects.slice(0,20).map(o=>Object.keys(o).slice(0,20));
    }catch(_){return []}
  }
  function classify(result,ref){
    if(result?.errors?.length)return {status:'error',match_score:0,detail:{gql_errors:result.errors.slice(0,3)}};
    const objects=collectObjects(result,[]),candidates=[],seen=new Set();
    for(const o of objects){
      const st=statusFromObject(o);
      if(!st)continue;
      const title=deepStringByKeys(o,['title','trackTitle','trackName','name']);
      const artists=deepStringByKeys(o,['artists','artistNames','artistName','artist','performers','creators']);
      if(!title)continue;
      const titleScore=similarity(ref.title,title);
      const artistScore=artists?similarity(ref.artists,artists):0;
      const score=titleScore*.70+artistScore*.30;
      const id=String(o.id||o.trackId||o.trackID||o.isrc||deepStringByKeys(o,['id','trackId','isrc'])||'');
      const sig=[st,title,artists,id].join('|').toLowerCase();if(seen.has(sig))continue;seen.add(sig);
      candidates.push({status:st,title,artists,score,id});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const best=candidates[0];
    if(!best)return {status:'ambiguous',match_score:0,detail:{reason:'no_deep_allowed_restricted_candidate',shape:compactShape(result)}};
    const titleOk=similarity(ref.title,best.title)>=0.72;
    const artistOk=!best.artists||similarity(ref.artists,best.artists)>=0.35;
    if(!titleOk||!artistOk||best.score<0.60)return {status:'not_found',matched_title:best.title,matched_artists:best.artists,match_score:Number(best.score.toFixed(4)),detail:{reason:'best_match_below_title_artist_threshold',top:candidates.slice(0,8)}};
    return {status:best.status,matched_title:best.title,matched_artists:best.artists,match_score:Number(best.score.toFixed(4)),twitch_track_id:best.id,detail:{top:candidates.slice(0,8)}};
  }

  async function search(ref){
    const h=captured.headers;
    const payload=[{
      operationName:'DJMusicCatalogSearchQuery',
      variables:{searchInput:{searchType:'TRACK',sortBy:'BEST_MATCH',term:(ref.title+' '+ref.artists).trim()}},
      extensions:{persistedQuery:{version:captured.version,sha256Hash:captured.sha256Hash}}
    }];
    const res=await originalFetch(GQL,{method:'POST',credentials:'include',headers:{
      'Content-Type':'application/json',
      'Authorization':h['authorization'],
      'Client-Id':h['client-id'],
      'Client-Integrity':h['client-integrity'],
      'Client-Session-Id':h['client-session-id'],
      'Client-Version':h['client-version'],
      'X-Device-Id':h['x-device-id']
    },body:JSON.stringify(payload)});
    if(!res.ok)throw new Error('Twitch GraphQL HTTP '+res.status);
    const data=await res.json();
    return classify(Array.isArray(data)?data[0]:data,ref);
  }

  async function bridgeFetch(path,opt={}){
    const res=await originalFetch(bridge.api+path,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}});
    let data={};try{data=await res.json()}catch(_){}
    if(!res.ok)throw new Error(data?.message||data?.error||('MediaForge HTTP '+res.status));
    return data;
  }

  function ensureUI(){
    if(ui||!document.documentElement)return;
    const mount=()=>{
      if(ui||!document.body)return;
      ui=document.createElement('div');
      ui.id='mediaforge-dj-scanner';
      ui.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;width:340px;background:#18181b;color:#fff;border:1px solid #4b3b67;border-radius:14px;padding:14px 16px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:13px/1.45 Inter,system-ui,sans-serif';
      ui.innerHTML='<div style="font-weight:800;font-size:14px">MediaForge · DJ Catalog Scanner</div><div id="mf-dj-state" style="margin-top:7px;color:#b7b7bd">Inicializando…</div><div style="height:7px;background:#2c2c30;border-radius:999px;margin-top:10px;overflow:hidden"><div id="mf-dj-bar" style="height:100%;width:0;background:#9146ff"></div></div><div id="mf-dj-count" style="margin-top:7px;color:#aaa;font-size:11px"></div>';
      document.body.appendChild(ui);updateUI();
    };
    if(document.body)mount();else window.addEventListener('DOMContentLoaded',mount,{once:true});
  }

  let progress={done:0,total:0,allowed:0,restricted:0,not_found:0,ambiguous:0,error:0};
  function updateUI(message){
    ensureUI();if(!ui)return;
    const st=ui.querySelector('#mf-dj-state'),bar=ui.querySelector('#mf-dj-bar'),count=ui.querySelector('#mf-dj-count');
    if(message)st.textContent=message;
    else if(!bridge.scan)st.textContent='Abra o scanner pelo MediaForge para vincular uma verificação.';
    else if(!ready())st.textContent='Faça uma busca qualquer no catálogo da Twitch uma única vez. O scan começa automaticamente.';
    else if(running)st.textContent='Verificando a playlist no catálogo oficial…';
    else st.textContent='Sessão do catálogo capturada. Preparando scan…';
    if(progress.total)bar.style.width=Math.min(100,progress.done/progress.total*100)+'%';
    count.textContent=progress.total?progress.done+'/'+progress.total+' · ✓ '+progress.allowed+' allowed · ⛔ '+progress.restricted+' restricted · ? '+(progress.not_found+progress.ambiguous)+' revisar':'';
  }

  async function sendBatch(batch){
    if(!batch.length)return;
    const out=await bridgeFetch('/api/dj-catalog/bridge/'+encodeURIComponent(bridge.scan)+'/'+encodeURIComponent(bridge.token)+'/results',{method:'POST',body:JSON.stringify({results:batch})});
    progress={done:Number(out.processed||progress.done),total:Number(out.total||progress.total),allowed:Number(out.allowed||0),restricted:Number(out.restricted||0),not_found:Number(out.not_found||0),ambiguous:Number(out.ambiguous||0),error:Number(out.error||0)};
    updateUI();
  }

  async function run(){
    if(running||!ready())return;running=true;updateUI();
    try{
      const manifest=await bridgeFetch('/api/dj-catalog/bridge/'+encodeURIComponent(bridge.scan)+'/'+encodeURIComponent(bridge.token)+'/manifest');
      const tracks=manifest.tracks||[];progress.total=tracks.length;updateUI();
      let batch=[];
      for(let i=0;i<tracks.length;i++){
        const ref=tracks[i];
        let cls;
        try{cls=await search(ref)}catch(e){cls={status:'error',match_score:0,detail:{error:String(e?.message||e)}}}
        const item={position:ref.position,spotify_id:ref.spotify_id,title:ref.title,artists:ref.artists,checked_at:new Date().toISOString(),...cls};
        batch.push(item);progress.done=i+1;
        if(item.status==='allowed')progress.allowed++;else if(item.status==='restricted')progress.restricted++;else if(item.status==='not_found')progress.not_found++;else if(item.status==='ambiguous')progress.ambiguous++;else progress.error++;
        updateUI();
        if(batch.length>=5||i===tracks.length-1){await sendBatch(batch);batch=[];}
        await new Promise(r=>setTimeout(r,180));
      }
      updateUI('Concluído. Os resultados já foram enviados ao MediaForge.');
      sessionStorage.removeItem('mf_dj_token');
    }catch(e){
      updateUI('Falha: '+String(e?.message||e));
      console.error('[MediaForge DJ Scanner]',e);
    }finally{running=false}
  }

  function maybeStart(){if(ready())setTimeout(run,250)}
  ensureUI();updateUI();maybeStart();
})();