// ==UserScript==
// @name         MediaForge — Twitch DJ Catalog Scanner
// @namespace    https://thebusinessflowtv.github.io/thebusinessflow/
// @version      1.0.6
// @description  Verifica automaticamente uma lista MediaForge no Twitch DJ Music Catalog pela própria interface autenticada, sem enviar cookies/OAuth da Twitch ao MediaForge.
// @match        https://dashboard.twitch.tv/u/*/dj*
// @run-at       document-idle
// @updateURL    https://thebusinessflowtv.github.io/thebusinessflow/control-center/twitch-dj-catalog-scanner.user.js
// @downloadURL  https://thebusinessflowtv.github.io/thebusinessflow/control-center/twitch-dj-catalog-scanner.user.js
// @grant        none
// ==/UserScript==

(function(){
  'use strict';

  const DEFAULT_API='https://mediaforge-api.guilhermeodsgn.workers.dev';
  const originalFetch=window.fetch.bind(window);
  let running=false,ui=null;
  let progress={done:0,total:0,allowed:0,restricted:0,not_found:0,ambiguous:0,error:0};

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const norm=v=>String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\b(feat|ft|featuring)\.?\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const toks=v=>new Set(norm(v).split(' ').filter(Boolean));
  function sim(a,b){const A=toks(a),B=toks(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return 2*n/(A.size+B.size);}

  function parseBridge(){
    const hash=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
    const x={scan:hash.get('mediaforge_scan')||'',token:hash.get('mediaforge_token')||'',api:hash.get('mediaforge_api')||''};
    if(x.scan&&x.token){
      sessionStorage.setItem('mf_dj_scan',x.scan);
      sessionStorage.setItem('mf_dj_token',x.token);
      sessionStorage.setItem('mf_dj_api',x.api||DEFAULT_API);
      try{history.replaceState(null,'',location.pathname+location.search)}catch(_){}
    }
    return {
      scan:x.scan||sessionStorage.getItem('mf_dj_scan')||'',
      token:x.token||sessionStorage.getItem('mf_dj_token')||'',
      api:(x.api||sessionStorage.getItem('mf_dj_api')||DEFAULT_API).replace(/\/$/,'')
    };
  }
  const bridge=parseBridge();

  async function bridgeFetch(path,opt={}){
    const res=await originalFetch(bridge.api+path,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}});
    let data={};try{data=await res.json()}catch(_){}
    if(!res.ok)throw new Error(data?.message||data?.error||('MediaForge HTTP '+res.status));
    return data;
  }

  function ensureUI(){
    if(ui)return;
    ui=document.createElement('div');
    ui.id='mediaforge-dj-scanner';
    ui.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;width:350px;background:#18181b;color:#fff;border:1px solid #4b3b67;border-radius:14px;padding:14px 16px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:13px/1.45 Inter,system-ui,sans-serif';
    ui.innerHTML='<div style="font-weight:800;font-size:14px">MediaForge · DJ Catalog Scanner</div><div id="mf-dj-state" style="margin-top:7px;color:#b7b7bd">Inicializando…</div><div style="height:7px;background:#2c2c30;border-radius:999px;margin-top:10px;overflow:hidden"><div id="mf-dj-bar" style="height:100%;width:0;background:#9146ff"></div></div><div id="mf-dj-count" style="margin-top:7px;color:#aaa;font-size:11px"></div>';
    document.body.appendChild(ui);
  }
  function updateUI(message){
    ensureUI();
    const st=ui.querySelector('#mf-dj-state'),bar=ui.querySelector('#mf-dj-bar'),count=ui.querySelector('#mf-dj-count');
    if(message)st.textContent=message;
    else if(!bridge.scan||!bridge.token)st.textContent='Abra a verificação pelo MediaForge.';
    else if(running)st.textContent='Consultando o catálogo pela interface oficial da Twitch…';
    else st.textContent='Pronto para iniciar.';
    if(progress.total)bar.style.width=Math.min(100,progress.done/progress.total*100)+'%';
    count.textContent=progress.total?progress.done+'/'+progress.total+' · ✓ '+progress.allowed+' allowed · ⛔ '+progress.restricted+' restricted · ? '+(progress.not_found+progress.ambiguous)+' revisar · ⚠ '+progress.error+' erros':'';
  }

  function visible(el){if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
  function findSearchInput(){
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    return inputs.find(i=>{
      const p=norm(i.getAttribute('placeholder')||'');
      return (p.includes('artista')&&p.includes('faixa'))||(p.includes('artist')&&(p.includes('track')||p.includes('title')));
    })||null;
  }
  function findSearchButton(input){
    const roots=[input?.closest('form'),input?.parentElement,input?.parentElement?.parentElement,document];
    for(const root of roots){
      if(!root)continue;
      const b=[...root.querySelectorAll('button')].find(x=>visible(x)&&/^(pesquisa|pesquisar|search)$/i.test(String(x.textContent||'').trim()));
      if(b)return b;
    }
    return null;
  }
  function setInput(input,value){
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(set)set.call(input,value);else input.value=value;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  async function waitSearchUI(timeout=15000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const input=findSearchInput(),button=input&&findSearchButton(input);
      if(input&&button)return {input,button};
      await sleep(250);
    }
    throw new Error('Campo de pesquisa do DJ Catalog não encontrado');
  }

  function stateOf(text){
    const s=norm(text);
    if(/\b(nao permitido|not allowed|restrito|restricted|bloqueado|blocked)\b/.test(s))return 'restricted';
    if(/\b(permitido|permitted|allowed)\b/.test(s))return 'allowed';
    return '';
  }
  function cleanLines(text){
    return String(text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  }
  function isStateLine(line){return !!stateOf(line);}
  function isDurationLine(line){return /^\d{1,2}:\d{2}$/.test(String(line||'').trim());}
  function candidateFromStateElement(el){
    const st=stateOf(el.innerText||el.textContent||'');if(!st)return null;
    let node=el,best=null;
    for(let depth=0;depth<7&&node;depth++,node=node.parentElement){
      const full=String(node.innerText||node.textContent||'').trim();
      if(!full||full.length>700)continue;
      const lines=cleanLines(full);
      if(lines.length<3||lines.length>9)continue;
      const stateIdx=lines.findIndex(isStateLine);
      if(stateIdx<0)continue;
      const useful=lines.filter(x=>!isStateLine(x)&&!isDurationLine(x));
      if(useful.length<2)continue;
      const cand={status:st,title:useful[0],artists:useful[1],full,depth};
      if(!best||depth<best.depth)best=cand;
    }
    return best;
  }
  function rowCandidates(){
    const out=[],seen=new Set();
    const all=[...document.querySelectorAll('body *')].filter(visible);
    for(const el of all){
      const txt=String(el.innerText||el.textContent||'').trim();
      if(!txt||txt.length>40||!stateOf(txt))continue;
      const cand=candidateFromStateElement(el);if(!cand)continue;
      const key=[cand.status,norm(cand.title),norm(cand.artists)].join('|');
      if(seen.has(key))continue;seen.add(key);out.push(cand);
    }
    return out;
  }
  function versionWords(text){
    const s=norm(text),keys=['remix','remastered','remaster','edit','mix','version','acoustic','live','radio','extended','vip','instrumental'];
    return new Set(keys.filter(k=>new RegExp('\\b'+k+'\\b').test(s)));
  }
  function versionCompatible(referenceTitle,resultTitle){
    const A=versionWords(referenceTitle),B=versionWords(resultTitle);
    if(!A.size&&!B.size)return true;
    if(A.size!==B.size)return false;
    for(const x of A)if(!B.has(x))return false;
    return true;
  }
  function artistParts(text){
    return String(text||'').split(/[,;&]/).map(norm).filter(x=>x.length>=2);
  }
  function artistCompatible(referenceArtists,resultArtists){
    const ref=artistParts(referenceArtists),res=norm(resultArtists);
    if(!ref.length||!res)return false;
    return ref.some(a=>a.length>=3&&(res.includes(a)||a.includes(res)));
  }

  async function waitForResults(ref,previousText,timeout=12000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const rows=rowCandidates();
      const changed=String(document.body.innerText||'')!==previousText;
      if(changed&&rows.length){
        const scored=rows.map(r=>{
          const titleScore=sim(ref.title,r.title),artistScore=sim(ref.artists,r.artists),versionOk=versionCompatible(ref.title,r.title),artistOk=artistCompatible(ref.artists,r.artists);
          return {...r,titleScore,artistScore,versionOk,artistOk,score:titleScore*0.72+artistScore*0.28};
        }).sort((a,b)=>b.score-a.score);
        const best=scored.find(x=>x.titleScore>=0.68&&x.artistOk&&x.versionOk);
        if(best){
          return {status:best.status,matched_title:best.title,matched_artists:best.artists,match_score:Number(best.score.toFixed(4)),detail:{source:'twitch_dashboard_dom',version_match:true,artist_match:true}};
        }
        const wrongVersion=scored.find(x=>x.titleScore>=0.68&&x.artistOk&&!x.versionOk);
        if(wrongVersion){
          return {status:'ambiguous',matched_title:wrongVersion.title,matched_artists:wrongVersion.artists,match_score:Number(wrongVersion.score.toFixed(4)),detail:{source:'twitch_dashboard_dom',reason:'different_version_or_remix',candidate_status:wrongVersion.status}};
        }
        const wrongArtist=scored.find(x=>x.titleScore>=0.68&&x.versionOk&&!x.artistOk);
        if(wrongArtist){
          return {status:'ambiguous',matched_title:wrongArtist.title,matched_artists:wrongArtist.artists,match_score:Number(wrongArtist.score.toFixed(4)),detail:{source:'twitch_dashboard_dom',reason:'title_match_artist_mismatch',candidate_status:wrongArtist.status}};
        }
      }
      await sleep(250);
    }
    const body=norm(document.body.innerText||'');
    if(body.includes('nenhum resultado')||body.includes('no results'))return {status:'not_found',match_score:0,detail:{source:'twitch_dashboard_dom',reason:'no_results_message'}};
    return {status:'not_found',match_score:0,detail:{source:'twitch_dashboard_dom',reason:'no_matching_row'}};
  }

  async function scanOne(ref){
    const {input,button}=await waitSearchUI();
    const term=(ref.title+' '+ref.artists).trim();
    const before=String(document.body.innerText||'');
    setInput(input,term);
    await sleep(120);
    button.click();
    return await waitForResults(ref,before);
  }

  async function sendBatch(batch){
    if(!batch.length)return;
    const out=await bridgeFetch('/api/dj-catalog/bridge/'+encodeURIComponent(bridge.scan)+'/'+encodeURIComponent(bridge.token)+'/results',{method:'POST',body:JSON.stringify({results:batch})});
    progress={done:Number(out.processed||progress.done),total:Number(out.total||progress.total),allowed:Number(out.allowed||0),restricted:Number(out.restricted||0),not_found:Number(out.not_found||0),ambiguous:Number(out.ambiguous||0),error:Number(out.error||0)};
    updateUI();
  }

  async function run(){
    if(running||!bridge.scan||!bridge.token)return;
    running=true;updateUI('Carregando as 215 faixas do MediaForge…');
    try{
      await waitSearchUI();
      const manifest=await bridgeFetch('/api/dj-catalog/bridge/'+encodeURIComponent(bridge.scan)+'/'+encodeURIComponent(bridge.token)+'/manifest');
      const tracks=manifest.tracks||[];
      progress={done:0,total:tracks.length,allowed:0,restricted:0,not_found:0,ambiguous:0,error:0};
      updateUI();
      let batch=[];
      for(let i=0;i<tracks.length;i++){
        const ref=tracks[i];
        updateUI('Consultando '+(i+1)+'/'+tracks.length+': '+ref.title);
        let cls;
        try{
          cls=await scanOne(ref);
        }catch(e){
          cls={status:'error',match_score:0,detail:{source:'twitch_dashboard_dom',error:String(e?.message||e)}};
        }
        const item={position:ref.position,spotify_id:ref.spotify_id,title:ref.title,artists:ref.artists,checked_at:new Date().toISOString(),...cls};
        batch.push(item);
        progress.done=i+1;
        if(item.status==='allowed')progress.allowed++;
        else if(item.status==='restricted')progress.restricted++;
        else if(item.status==='not_found')progress.not_found++;
        else if(item.status==='ambiguous')progress.ambiguous++;
        else progress.error++;
        updateUI();
        if(batch.length>=5||i===tracks.length-1){await sendBatch(batch);batch=[];}
        await sleep(650);
      }
      if(progress.error)updateUI('Finalizado com '+progress.error+' erro(s). Revise antes de usar.');
      else updateUI('Concluído. Os resultados já foram enviados ao MediaForge.');
      if(!progress.error)sessionStorage.removeItem('mf_dj_token');
    }catch(e){
      updateUI('Falha: '+String(e?.message||e));
      console.error('[MediaForge DJ Scanner]',e);
    }finally{running=false;}
  }

  ensureUI();
  updateUI();
  setTimeout(run,900);
})();