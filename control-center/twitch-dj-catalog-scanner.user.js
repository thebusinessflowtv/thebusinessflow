// ==UserScript==
// @name         MediaForge — Twitch DJ Catalog Scanner
// @namespace    https://thebusinessflowtv.github.io/thebusinessflow/
// @version      1.1.2
// @description  Verifica listas do MediaForge no Twitch DJ Music Catalog com busca em cascata, validação forte de título/artista/versão e revisão automática de resultados incertos.
// @match        https://dashboard.twitch.tv/u/*/dj*
// @run-at       document-idle
// @updateURL    https://thebusinessflowtv.github.io/thebusinessflow/control-center/twitch-dj-catalog-scanner.user.js
// @downloadURL  https://thebusinessflowtv.github.io/thebusinessflow/control-center/twitch-dj-catalog-scanner.user.js
// @grant        GM_xmlhttpRequest
// @connect      peterlofi.odsgn.com.br
// @connect      mediaforge-api.guilhermeodsgn.workers.dev
// @connect      146.59.156.224
// ==/UserScript==

(function(){
  'use strict';

  const DEFAULT_API='https://mediaforge-api.guilhermeodsgn.workers.dev';
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
    const url=bridge.api+path;
    const method=String(opt.method||'GET').toUpperCase();
    const headers={'content-type':'application/json',...(opt.headers||{})};
    const body=opt.body==null?undefined:String(opt.body);

    if(typeof GM_xmlhttpRequest==='function'){
      return await new Promise((resolve,reject)=>{
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data:body,
          timeout:20000,
          anonymous:false,
          onload:r=>{
            let data={};
            try{data=r.responseText?JSON.parse(r.responseText):{}}catch(_){data={raw:String(r.responseText||'').slice(0,1000)}}
            if(r.status<200||r.status>=300){
              reject(new Error(data?.message||data?.error||('MediaForge HTTP '+r.status)));
              return;
            }
            resolve(data);
          },
          ontimeout:()=>reject(new Error('MediaForge timeout')),
          onerror:e=>reject(new Error('MediaForge request failed'+(e?.error?': '+e.error:'')))
        });
      });
    }

    const res=await fetch(url,{...opt,headers});
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
    if(/\b(nao permitid[oa]s?|not allowed|restrit[oa]s?|restricted|bloquead[oa]s?|blocked)\b/.test(s))return 'restricted';
    if(/\b(permitid[oa]s?|permitted|allowed)\b/.test(s))return 'allowed';
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
    const s=norm(text);
    const phrases=['sped up','slowed down','radio edit','radio version','extended mix','original mix'];
    const keys=['remix','remastered','remaster','edit','mix','version','acoustic','live','radio','extended','vip','instrumental','karaoke'];
    const out=new Set();
    for(const p of phrases)if(s.includes(p))out.add(p);
    for(const k of keys)if(new RegExp('\\b'+k+'\\b').test(s))out.add(k);
    return out;
  }
  function versionCompatible(referenceTitle,resultTitle){
    const A=versionWords(referenceTitle),B=versionWords(resultTitle);
    if(!A.size&&!B.size)return true;
    if(A.size!==B.size)return false;
    for(const x of A)if(!B.has(x))return false;
    return true;
  }
  function stripFeature(text){
    return String(text||'')
      .replace(/[\[(](?:[^\])]*(?:feat(?:uring)?|ft\.)[^\])]*?)[\])]/ig,' ')
      .replace(/\b(?:feat(?:uring)?|ft\.)\b.*$/ig,' ')
      .replace(/\s+/g,' ').trim();
  }
  function stripVersion(text){
    let s=String(text||'');
    s=s.replace(/[\[(]([^\])]+)[\])]/g,(m,inside)=>versionWords(inside).size? ' ' : m);
    s=s.replace(/\s+-\s+(?:radio edit|radio version|extended mix|original mix|remix|remaster(?:ed)?|acoustic|live|instrumental)\b.*$/ig,' ');
    return stripFeature(s).replace(/\s+/g,' ').trim();
  }
  function artistParts(text){
    return String(text||'')
      .split(/\s*(?:,|;|&|\bx\b|\bfeat(?:uring)?\.?\b|\bft\.?\b)\s*/i)
      .map(norm).filter(x=>x.length>=2);
  }
  function primaryArtist(text){return artistParts(text)[0]||norm(text);}
  function artistSimilarity(referenceArtists,resultArtists){
    const refs=artistParts(referenceArtists),res=artistParts(resultArtists);
    const raw=norm(resultArtists);
    if(!refs.length||(!res.length&&!raw))return 0;
    let matched=0;
    for(const a of refs){
      if(!a)continue;
      const ok=res.some(b=>a===b||a.includes(b)||b.includes(a)||sim(a,b)>=0.80)||raw.includes(a);
      if(ok)matched++;
    }
    const coverage=matched/Math.max(1,Math.min(refs.length,2));
    const primary=refs[0]&&(raw.includes(refs[0])||res.some(b=>b===refs[0]||sim(b,refs[0])>=0.86))?1:0;
    return Math.min(1,coverage*.72+primary*.28);
  }
  function titleSimilarity(referenceTitle,resultTitle){
    const a=norm(referenceTitle),b=norm(resultTitle);
    if(!a||!b)return 0;
    if(a===b)return 1;
    if(a.includes(b)||b.includes(a)){
      const ratio=Math.min(a.length,b.length)/Math.max(a.length,b.length);
      if(ratio>=0.72)return Math.max(.90,ratio);
    }
    return sim(referenceTitle,resultTitle);
  }
  function candidateKey(c){
    return [norm(c.title),norm(c.artists),c.status].join('|');
  }
  function candidateSignature(rows){
    return rows.map(r=>candidateKey(r)).sort().join('||');
  }
  function scoreRows(ref,rows){
    return rows.map(r=>{
      const titleScore=titleSimilarity(ref.title,r.title);
      const artistScore=artistSimilarity(ref.artists,r.artists);
      const versionOk=versionCompatible(ref.title,r.title);
      const primaryOk=artistScore>=0.48;
      const score=titleScore*.74+artistScore*.26;
      const exactish=titleScore>=0.96&&artistScore>=0.58&&versionOk;
      const acceptable=titleScore>=0.84&&artistScore>=0.46&&versionOk&&score>=0.76;
      return {...r,titleScore,artistScore,versionOk,primaryOk,score,exactish,acceptable};
    }).sort((a,b)=>b.score-a.score);
  }
  function buildTerms(ref){
    const fullTitle=String(ref.title||'').trim();
    const cleanTitle=stripVersion(fullTitle);
    const fullArtists=String(ref.artists||'').trim();
    const first=primaryArtist(fullArtists);
    const variants=[
      [fullTitle,fullArtists].filter(Boolean).join(' '),
      [fullTitle,first].filter(Boolean).join(' '),
      fullTitle,
      [cleanTitle,first].filter(Boolean).join(' '),
      cleanTitle
    ].map(x=>String(x||'').replace(/\s+/g,' ').trim()).filter(Boolean);
    return [...new Set(variants.map(x=>norm(x)))].map(n=>variants.find(x=>norm(x)===n)).filter(Boolean);
  }

  async function waitForResults(ref,beforeSig,timeout=9000){
    const start=Date.now();
    let lastRows=[];
    while(Date.now()-start<timeout){
      const rows=rowCandidates();
      lastRows=rows;
      const sig=candidateSignature(rows);
      if(rows.length&&(sig!==beforeSig||Date.now()-start>1200)){
        const scored=scoreRows(ref,rows);
        if(scored.length)return {kind:'rows',scored};
      }
      const body=norm(document.body.innerText||'');
      if((body.includes('nenhum resultado')||body.includes('no results'))&&Date.now()-start>650){
        return {kind:'no_results',scored:[]};
      }
      await sleep(220);
    }
    return {kind:'timeout',scored:scoreRows(ref,lastRows)};
  }

  async function searchTerm(ref,term,timeout){
    const {input,button}=await waitSearchUI();
    const beforeSig=candidateSignature(rowCandidates());
    setInput(input,'');
    await sleep(80);
    setInput(input,term);
    await sleep(140);
    button.click();
    const result=await waitForResults(ref,beforeSig,timeout||9000);
    return {term,...result};
  }

  function summarizeCandidate(x){
    if(!x)return null;
    return {
      status:x.status,title:x.title,artists:x.artists,
      score:Number(x.score.toFixed(4)),
      title_score:Number(x.titleScore.toFixed(4)),
      artist_score:Number(x.artistScore.toFixed(4)),
      version_match:!!x.versionOk
    };
  }

  function finalizeAttempts(ref,attempts){
    const all=[];
    for(const a of attempts)for(const x of (a.scored||[]))all.push({...x,term:a.term});
    all.sort((a,b)=>b.score-a.score);

    const strong=all.filter(x=>x.acceptable);
    const exactRestricted=strong.find(x=>x.status==='restricted'&&x.exactish);
    if(exactRestricted){
      return {
        status:'restricted',matched_title:exactRestricted.title,matched_artists:exactRestricted.artists,
        match_score:Number(exactRestricted.score.toFixed(4)),
        detail:{source:'twitch_dashboard_dom_v2',confidence:'high',reason:'exact_restricted_match',attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
      };
    }

    const exactAllowed=strong.find(x=>x.status==='allowed'&&x.exactish);
    const conflictingExact=strong.find(x=>x.exactish&&exactAllowed&&x.status!==exactAllowed.status&&norm(x.title)===norm(exactAllowed.title)&&artistSimilarity(x.artists,exactAllowed.artists)>=.8);
    if(exactAllowed&&!conflictingExact){
      return {
        status:'allowed',matched_title:exactAllowed.title,matched_artists:exactAllowed.artists,
        match_score:Number(exactAllowed.score.toFixed(4)),
        detail:{source:'twitch_dashboard_dom_v2',confidence:'high',reason:'exact_allowed_match',attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
      };
    }

    const best=strong[0];
    if(best){
      const sameTrack=strong.filter(x=>norm(x.title)===norm(best.title)&&artistSimilarity(x.artists,best.artists)>=.80&&x.versionOk===best.versionOk);
      const statuses=new Set(sameTrack.map(x=>x.status));
      if(statuses.size>1){
        return {
          status:'ambiguous',matched_title:best.title,matched_artists:best.artists,match_score:Number(best.score.toFixed(4)),
          detail:{source:'twitch_dashboard_dom_v2',reason:'conflicting_catalog_status',candidates:sameTrack.slice(0,5).map(summarizeCandidate),attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
        };
      }

      const corroboration=strong.filter(x=>x.status===best.status&&norm(x.title)===norm(best.title)&&artistSimilarity(x.artists,best.artists)>=.80).length;
      const threshold=best.status==='restricted'?.76:.82;
      if(best.score>=threshold&&(best.status==='restricted'||corroboration>=2)){
        return {
          status:best.status,matched_title:best.title,matched_artists:best.artists,match_score:Number(best.score.toFixed(4)),
          detail:{source:'twitch_dashboard_dom_v2',confidence:best.status==='restricted'?'medium_high':'medium',reason:'corroborated_multi_query_match',corroboration,attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
        };
      }
    }

    const wrongVersion=all.find(x=>x.titleScore>=.82&&x.artistScore>=.46&&!x.versionOk);
    if(wrongVersion){
      return {
        status:'ambiguous',matched_title:wrongVersion.title,matched_artists:wrongVersion.artists,match_score:Number(wrongVersion.score.toFixed(4)),
        detail:{source:'twitch_dashboard_dom_v2',reason:'different_version_or_remix',candidate_status:wrongVersion.status,attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
      };
    }

    const wrongArtist=all.find(x=>x.titleScore>=.88&&x.artistScore<.46&&x.versionOk);
    if(wrongArtist){
      return {
        status:'ambiguous',matched_title:wrongArtist.title,matched_artists:wrongArtist.artists,match_score:Number(wrongArtist.score.toFixed(4)),
        detail:{source:'twitch_dashboard_dom_v2',reason:'title_match_artist_mismatch',candidate_status:wrongArtist.status,attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
      };
    }

    const anyRows=attempts.some(a=>(a.scored||[]).length);
    return {
      status:anyRows?'ambiguous':'not_found',
      match_score:all[0]?Number(all[0].score.toFixed(4)):0,
      matched_title:all[0]?.title,matched_artists:all[0]?.artists,
      detail:{source:'twitch_dashboard_dom_v2',reason:anyRows?'no_candidate_passed_confidence_gate':'exhausted_query_variants',attempts:attempts.map(a=>({term:a.term,kind:a.kind,top:summarizeCandidate(a.scored?.[0])}))}
    };
  }

  async function scanOne(ref){
    const terms=buildTerms(ref),attempts=[];
    for(let i=0;i<terms.length;i++){
      const attempt=await searchTerm(ref,terms[i],i<2?8500:6500);
      attempts.push(attempt);
      const top=attempt.scored?.[0];
      if(top?.status==='restricted'&&top.exactish){
        return finalizeAttempts(ref,attempts);
      }
      if(top?.status==='allowed'&&top.exactish){
        return finalizeAttempts(ref,attempts);
      }
      await sleep(240);
    }
    return finalizeAttempts(ref,attempts);
  }

  async function sendBatch(batch){
    if(!batch.length)return;
    const out=await bridgeFetch('/api/dj-catalog/bridge/'+encodeURIComponent(bridge.scan)+'/'+encodeURIComponent(bridge.token)+'/results',{method:'POST',body:JSON.stringify({results:batch})});
    progress={done:Number(out.processed||progress.done),total:Number(out.total||progress.total),allowed:Number(out.allowed||0),restricted:Number(out.restricted||0),not_found:Number(out.not_found||0),ambiguous:Number(out.ambiguous||0),error:Number(out.error||0)};
    updateUI();
  }

  async function run(){
    if(running||!bridge.scan||!bridge.token)return;
    running=true;updateUI('Carregando as faixas do MediaForge…');
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