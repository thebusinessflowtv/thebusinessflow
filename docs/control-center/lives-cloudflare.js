(()=>{
  const API=(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'').replace(/\/$/,'');
  const TOKEN_KEY='mediaforge_token';
  let catalog=null,sessions=[],loading=false;
  const selectedSeriesIds=new Set();
  const selectedMixIds=new Set();
  const manualTrackIds=new Set();
  const excludedTrackIds=new Set();
  const draft={title:'Peter Lofi Radio 🎧 Lofi Beats for Work, Study, Focus & Relax 🔴 Live on Peter Lofi',description:'',duration:'60',visual:''};

  const root=()=>document.getElementById('content');
  const token=()=>localStorage.getItem(TOKEN_KEY)||'';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtBytes=n=>{n=Number(n||0);if(n>=1024**3)return `${(n/1024**3).toFixed(2)} GB`;if(n>=1024**2)return `${(n/1024**2).toFixed(1)} MB`;if(n>=1024)return `${(n/1024).toFixed(1)} KB`;return `${n} B`;};
  const fmtDate=d=>{try{return new Date(d).toLocaleString('pt-BR')}catch(_){return d||''}};

  async function api(path,opt={}){
    if(!API)throw new Error('Backend Cloudflare ainda não foi configurado.');
    const headers={...(opt.headers||{}),authorization:`Bearer ${token()}`};
    if(opt.body&&!(opt.body instanceof Blob)&&!(opt.body instanceof ArrayBuffer)&&!headers['content-type'])headers['content-type']='application/json';
    const res=await fetch(API+path,{...opt,headers});
    let data=null;const ct=res.headers.get('content-type')||'';
    try{data=ct.includes('json')?await res.json():await res.text()}catch(_){}
    if(res.status===401){localStorage.removeItem(TOKEN_KEY);location.replace('./secure.html');throw new Error('Sessão expirada.');}
    if(!res.ok)throw new Error(data?.message||data?.error||`HTTP ${res.status}`);
    return data;
  }

  function captureDraft(){
    const t=document.getElementById('title'),d=document.getElementById('description'),du=document.getElementById('duration'),v=document.getElementById('visual');
    if(t)draft.title=t.value;if(d)draft.description=d.value;if(du)draft.duration=du.value;if(v)draft.visual=v.value;
  }
  function selectedIds(){return [...document.querySelectorAll('.pick:checked')].map(x=>x.value);}
  function groupTracks(){
    const out=new Set();
    for(const s of catalog?.series||[])if(selectedSeriesIds.has(String(s.id)))for(const id of s.track_ids||[])out.add(String(id));
    for(const m of catalog?.hour_mixes||[])if(selectedMixIds.has(String(m.id)))for(const id of m.track_ids||[])out.add(String(id));
    return out;
  }
  function combinedSelection(){
    const out=groupTracks();
    for(const id of manualTrackIds)out.add(String(id));
    for(const id of excludedTrackIds)out.delete(String(id));
    return out;
  }
  function applySelection(){
    const ids=combinedSelection();
    document.querySelectorAll('.pick').forEach(x=>x.checked=ids.has(String(x.value)));
    document.querySelectorAll('.seriesPick').forEach(x=>x.checked=selectedSeriesIds.has(String(x.value)));
    document.querySelectorAll('.mixPick').forEach(x=>x.checked=selectedMixIds.has(String(x.value)));
    updateCount();
  }
  function updateCount(){
    const el=document.getElementById('selectedCount');if(el)el.textContent=`${selectedIds().length} selecionadas de ${(catalog?.tracks||[]).length} disponíveis`;
    const s=document.getElementById('seriesCount');if(s)s.textContent=`${selectedSeriesIds.size} série${selectedSeriesIds.size===1?'':'s'} selecionada${selectedSeriesIds.size===1?'':'s'}`;
    const m=document.getElementById('mixCount');if(m)m.textContent=`${selectedMixIds.size} faixa${selectedMixIds.size===1?'':'s'} longa${selectedMixIds.size===1?'':'s'} selecionada${selectedMixIds.size===1?'':'s'}`;
  }
  function orderedSelection(){const checked=new Set(selectedIds());return (catalog?.tracks||[]).filter(t=>checked.has(String(t.id))).map(t=>String(t.id));}

  function groupBox(type,items){
    const cls=type==='series'?'seriesPick':'mixPick',chosen=type==='series'?selectedSeriesIds:selectedMixIds;
    if(!items.length)return '<div class="tiny muted">Nenhuma opção disponível.</div>';
    return `<div style="display:grid;gap:6px;border:1px solid #44444a;background:#0f0f11;border-radius:10px;padding:8px;max-height:190px;overflow:auto">${items.map(x=>{
      const subtitle=type==='series'?`${(x.track_ids||[]).length} faixas`:`${Math.round((x.duration_seconds||0)/60)} min`;
      return `<label style="display:grid;grid-template-columns:auto 1fr;gap:9px;align-items:center;padding:9px 10px;border:1px solid #2c2c30;background:#151518;border-radius:8px;cursor:pointer"><input class="${cls}" type="checkbox" value="${esc(x.id)}" ${chosen.has(String(x.id))?'checked':''}><span><b class="small">${esc(x.name)}</b><span class="tiny muted" style="display:block;margin-top:2px">${subtitle}</span></span></label>`;
    }).join('')}</div>`;
  }

  function render(){
    if(!API){root().innerHTML='<div class="card"><b>Backend Cloudflare ainda não implantado</b></div>';return;}
    const tracks=catalog?.tracks||[],series=catalog?.series||[],mixes=catalog?.hour_mixes||[],assets=catalog?.assets||[];
    const cards=sessions.map(s=>`<div class="card livecard" data-live="${esc(s.id)}"><div class="row between"><b>${esc(s.title)}</b><span class="pill ${esc(s.status)}">${esc(s.status)}</span></div>${s.description?`<div class="tiny muted" style="margin-top:7px">${esc(s.description)}</div>`:''}<div class="tiny muted" style="margin-top:7px">${fmtDate(s.created_at)} · ${s.duration_minutes===0?'contínua':`${s.duration_minutes||0} min`}</div>${['queued','starting','live','reconnecting','stopping'].includes(String(s.status))?`<button class="btn danger stopLive" data-id="${esc(s.id)}" style="margin-top:12px">Encerrar</button>`:''}</div>`).join('')||'<div class="card"><span class="small muted">Nenhuma live registrada neste backend ainda.</span></div>';

    root().innerHTML=`<div class="grid grid2"><section class="card">
      <div class="row between"><div><b>Configurar live da Kick</b><div class="tiny muted" style="margin-top:4px">Cloudflare Worker + D1 + R2. Sem dependência do Supabase.</div></div><span class="pill live">R2 / D1</span></div>
      <div class="field"><label>TÍTULO DA LIVE</label><input id="title" class="input" value="${esc(draft.title)}"></div>
      <div class="field"><label>DESCRIÇÃO / NOTAS</label><textarea id="description" class="input" rows="4" placeholder="Descrição interna da transmissão">${esc(draft.description)}</textarea></div>
      <div class="field"><label>DURAÇÃO</label><select id="duration" class="select"><option value="0" ${draft.duration==='0'?'selected':''}>Contínua</option><option value="60" ${draft.duration==='60'?'selected':''}>1 hora</option><option value="120" ${draft.duration==='120'?'selected':''}>2 horas</option><option value="240" ${draft.duration==='240'?'selected':''}>4 horas</option><option value="480" ${draft.duration==='480'?'selected':''}>8 horas</option></select></div>

      <div class="field"><label>SÉRIES / PLAYLISTS GERADAS — SELEÇÃO MÚLTIPLA</label>${groupBox('series',series)}<div id="seriesCount" class="tiny muted" style="margin-top:6px"></div></div>
      <div class="field"><label>FAIXAS LONGAS / MÚSICAS DE 1 HORA — SELEÇÃO MÚLTIPLA</label>${groupBox('mix',mixes)}<div id="mixCount" class="tiny muted" style="margin-top:6px"></div></div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.5">Você pode combinar várias séries + várias faixas longas + músicas avulsas na mesma live. Faixas repetidas entram apenas uma vez.</div>
      <div class="row" style="margin-top:10px"><button id="selectAll" class="btn">Selecionar todas</button><button id="clearAll" class="btn">Limpar tudo</button><span id="selectedCount" class="tiny muted"></span></div>
      <div class="field"><label>BUSCAR MÚSICA</label><input id="trackSearch" class="input" placeholder="Buscar por nome, série ou estilo"></div>
      <div id="trackList" class="tracklist">${tracks.map(t=>`<label class="track" data-search="${esc(`${t.title} ${t.collection_name||''} ${t.style||''}`.toLowerCase())}"><input class="pick" type="checkbox" value="${esc(t.id)}"><span><b class="small">${esc(t.title)}</b><span class="tiny muted" style="display:block;margin-top:2px">${esc(t.collection_name||t.style||'Faixa')} · ${Math.round((t.duration_seconds||0)/60*10)/10} min</span></span><span class="pill">${t.source==='peter_lofi_series'?'série':'mix'}</span></label>`).join('')}</div>
    </section><aside class="grid"><section class="card">
      <b>Visual da transmissão</b><div class="tiny muted" style="margin-top:5px">Imagem = fixa. Vídeo = duração completa em loop durante toda a live.</div>
      <div class="field"><label>VISUAL JÁ ENVIADO</label><select id="visual" class="select"><option value="">Sem visual personalizado</option>${assets.map(a=>`<option value="${esc(a.id)}" ${draft.visual===String(a.id)?'selected':''}>${esc(a.title)} · ${fmtBytes(a.size_bytes)}</option>`).join('')}</select></div>
      <div class="field"><label class="assetdrop" for="visualFile"><b>+ Selecionar JPG, PNG, WEBP, MP4 ou MOV</b><small>Upload multipart direto para Cloudflare R2.</small></label><input id="visualFile" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" hidden><div class="uploadbar"><span id="uploadBar"></span></div><div id="uploadStatus" class="tiny muted" style="margin-top:7px"></div></div>
      <button id="start" class="btn kick block" style="margin-top:14px">● Iniciar na Kick</button>
    </section><section class="note"><b>Kick:</b> H.264 1080p / 60 FPS, CBR 8000 kbps, keyframe 2 s e AAC.</section></aside></div>
    <div style="height:14px"></div><div class="row between"><b>Lives recentes</b><button id="refreshSessions" class="btn">↻ Atualizar</button></div><div class="grid" style="margin-top:10px">${cards}</div>`;
    bind();applySelection();
  }

  function bind(){
    document.querySelectorAll('.seriesPick').forEach(x=>x.onchange=()=>{x.checked?selectedSeriesIds.add(String(x.value)):selectedSeriesIds.delete(String(x.value));applySelection();});
    document.querySelectorAll('.mixPick').forEach(x=>x.onchange=()=>{x.checked?selectedMixIds.add(String(x.value)):selectedMixIds.delete(String(x.value));applySelection();});
    document.querySelectorAll('.pick').forEach(x=>x.onchange=()=>{const id=String(x.value);if(x.checked){manualTrackIds.add(id);excludedTrackIds.delete(id);}else{manualTrackIds.delete(id);excludedTrackIds.add(id);}updateCount();});
    document.getElementById('selectAll').onclick=()=>{for(const t of catalog?.tracks||[])manualTrackIds.add(String(t.id));excludedTrackIds.clear();applySelection();};
    document.getElementById('clearAll').onclick=()=>{selectedSeriesIds.clear();selectedMixIds.clear();manualTrackIds.clear();excludedTrackIds.clear();applySelection();};
    document.getElementById('trackSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('#trackList .track').forEach(el=>el.style.display=!q||el.dataset.search.includes(q)?'grid':'none');};
    ['title','description','duration','visual'].forEach(id=>document.getElementById(id)?.addEventListener('change',captureDraft));
    document.getElementById('visualFile').onchange=e=>uploadFile(e.target.files?.[0]);
    document.getElementById('start').onclick=startLive;
    document.getElementById('refreshSessions').onclick=loadSessions;
    document.querySelectorAll('.stopLive').forEach(b=>b.onclick=()=>stopLive(b.dataset.id));
  }

  async function uploadPart(assetId,uploadId,partNumber,blob,retries=3){let last;for(let i=0;i<retries;i++)try{return await api(`/api/uploads/part?asset_id=${encodeURIComponent(assetId)}&upload_id=${encodeURIComponent(uploadId)}&part_number=${partNumber}`,{method:'PUT',body:blob,headers:{'content-type':'application/octet-stream'}})}catch(e){last=e;await new Promise(r=>setTimeout(r,1000*(i+1)));}throw last;}
  async function uploadFile(file){
    if(!file)return;const status=document.getElementById('uploadStatus'),bar=document.getElementById('uploadBar'),startBtn=document.getElementById('start');startBtn.disabled=true;bar.style.width='0%';status.textContent=`${file.name} · ${fmtBytes(file.size)} · preparando upload R2…`;let init=null;
    try{init=await api('/api/uploads/init',{method:'POST',body:JSON.stringify({name:file.name,title:file.name,mime_type:file.type||'application/octet-stream',size_bytes:file.size})});const chunk=Number(init.chunk_size||50*1024*1024),count=Math.ceil(file.size/chunk),results=new Array(count);let doneBytes=0,next=0;async function worker(){while(true){const idx=next++;if(idx>=count)return;const start=idx*chunk,end=Math.min(file.size,start+chunk),blob=file.slice(start,end);const p=await uploadPart(init.asset_id,init.upload_id,idx+1,blob);results[idx]=p;doneBytes+=blob.size;const pct=Math.round(doneBytes/file.size*100);bar.style.width=`${pct}%`;status.textContent=`${file.name} · ${fmtBytes(file.size)} · enviando ${pct}% (${idx+1}/${count})`;}}await Promise.all(Array.from({length:Math.min(3,count)},()=>worker()));const completed=await api('/api/uploads/complete',{method:'POST',body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id,parts:results})});const asset=completed.asset;catalog.assets=[asset,...(catalog.assets||[]).filter(a=>a.id!==asset.id)];draft.visual=String(asset.id);render();const s=document.getElementById('uploadStatus');if(s)s.textContent=`✓ ${file.name} · upload concluído no R2 e selecionado como visual desta live`;}
    catch(e){if(init)try{await api('/api/uploads/abort',{method:'POST',body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id})})}catch(_){}status.textContent=`Falha no upload: ${e.message}`;status.style.color='#ff9ca6';bar.style.width='0%';}
    finally{const b=document.getElementById('start');if(b)b.disabled=false;}
  }

  async function startLive(){captureDraft();const btn=document.getElementById('start'),ids=orderedSelection();if(!ids.length){alert('Selecione pelo menos uma música, série ou faixa longa.');return;}btn.disabled=true;btn.textContent='Abrindo live…';try{await api('/api/live/start',{method:'POST',body:JSON.stringify({platform:'kick',track_ids:ids,duration_minutes:Number(draft.duration||0),title:draft.title.trim(),description:draft.description,visual_asset_id:draft.visual||null})});alert(`Live da Kick enviada com ${ids.length} faixa${ids.length===1?'':'s'} selecionada${ids.length===1?'':'s'}.`);await loadSessions();}catch(e){alert('Falha ao iniciar: '+e.message);}finally{btn.disabled=false;btn.textContent='● Iniciar na Kick';}}
  async function stopLive(id){if(!confirm('Encerrar esta live agora?'))return;try{await api(`/api/live/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});await loadSessions();}catch(e){alert('Falha ao encerrar: '+e.message);}}
  async function loadSessions(){try{captureDraft();const x=await api('/api/live-sessions');sessions=x.sessions||[];render();}catch(e){console.error(e);}}
  async function load(){if(loading)return;loading=true;try{if(!API){render();return;}await api('/api/me');const [c,s]=await Promise.all([api('/api/catalog'),api('/api/live-sessions')]);catalog=c;sessions=s.sessions||[];render();}catch(e){root().innerHTML=`<div class="card" style="color:#ffb2ba"><b>Falha ao carregar o MediaForge</b><div class="small" style="margin-top:7px">${esc(e.message)}</div><button class="btn" style="margin-top:12px" onclick="location.reload()">↻ Tentar novamente</button></div>`;}finally{loading=false;}}
  document.querySelectorAll('.platform-tabs .tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.platform-tabs .tab').forEach(x=>x.classList.remove('on'));tab.classList.add('on');if(tab.dataset.platform==='youtube')alert('Nesta primeira etapa da migração, a live sem Supabase está liberada para a Kick. O YouTube será conectado em seguida.');});
  document.getElementById('refresh')?.addEventListener('click',load);load();setInterval(()=>{if(document.visibilityState==='visible'&&catalog)loadSessions();},15000);
})();
