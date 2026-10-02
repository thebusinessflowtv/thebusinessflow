(()=>{
  const API=(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'').replace(/\/$/,'');
  const TOKEN_KEY='mediaforge_token';
  const TWITCH_RAW='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control';
  let catalog=null,sessions=[],loading=false,activePlatform='kick';
  const selectedSeriesIds=new Set(),selectedMixIds=new Set(),manualTrackIds=new Set(),excludedTrackIds=new Set();
  const drafts={
    kick:{title:'Peter Lofi Radio 🎧 Lofi Beats for Work, Study, Focus & Relax 🔴 Live on Peter Lofi',description:'',duration:'60',visual:'',thumbnail:''},
    youtube:{title:'Peter Lofi Radio 🎧 Lofi Beats for Work, Study, Focus & Relax 🔴 Live',description:'Lofi beats for work, study, focus and relaxation. Live on Peter Lofi.',duration:'60',visual:'',thumbnail:''}
  };
  const root=()=>document.getElementById('content');
  const token=()=>localStorage.getItem(TOKEN_KEY)||'';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtBytes=n=>{n=Number(n||0);if(n>=1024**3)return `${(n/1024**3).toFixed(2)} GB`;if(n>=1024**2)return `${(n/1024**2).toFixed(1)} MB`;if(n>=1024)return `${(n/1024).toFixed(1)} KB`;return `${n} B`;};
  const fmtDate=d=>{try{return new Date(d).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}catch(_){return d||''}};
  const platformName=p=>p==='youtube'?'YouTube':p==='twitch'?'Twitch':'Kick';
  const platformIcon=p=>p==='youtube'?'▶':p==='twitch'?'◈':'●';

  async function api(path,opt={}){
    if(!API)throw new Error('Backend Cloudflare ainda não foi configurado.');
    const headers={...(opt.headers||{}),authorization:`Bearer ${token()}`};
    if(opt.body&&!(opt.body instanceof Blob)&&!(opt.body instanceof ArrayBuffer)&&!headers['content-type'])headers['content-type']='application/json';
    const res=await fetch(API+path,{...opt,headers});let data=null;const ct=res.headers.get('content-type')||'';
    try{data=ct.includes('json')?await res.json():await res.text()}catch(_){}
    if(res.status===401){localStorage.removeItem(TOKEN_KEY);location.replace('./secure.html');throw new Error('Sessão expirada.');}
    if(!res.ok)throw new Error(data?.message||data?.error||`HTTP ${res.status}`);return data;
  }

  async function rawJson(path){
    try{
      const r=await fetch(`${TWITCH_RAW}/${path}?v=${Date.now()}`,{cache:'no-store'});
      return r.ok?await r.json():null;
    }catch(_){return null}
  }

  async function mergeTwitchSession(base){
    const list=[...(base||[])];
    const active=await rawJson('twitch-active.json');
    if(!active?.session_id)return list;
    const result=await rawJson(`twitch-live-results/${active.session_id}.json`)||active;
    const exists=list.some(x=>String(x.platform)==='twitch'&&String(x.id)===String(active.session_id));
    if(!exists){
      list.unshift({
        id:String(active.session_id),
        platform:'twitch',
        title:result.title||active.title||'Peter Lofi Gaming Radio',
        description:result.description||'',
        status:result.status||active.status||'unknown',
        created_at:result.live_at||result.updated_at||active.updated_at,
        duration_minutes:0,
        github_run_url:result.github_run_url||active.github_run_url||'',
        encoder_resolution:result.encoder_resolution||'1920x1080',
        encoder_fps:result.encoder_fps||30,
        encoder_bitrate_kbps:result.encoder_bitrate_kbps||4500,
        encoder_connected:result.encoder_connected!==false,
        _external_twitch:true
      });
    }
    return list.sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
  }

  function captureDraft(){const d=drafts[activePlatform],ids=['title','description','duration','visual','thumbnail'];for(const id of ids){const el=document.getElementById(id);if(el)d[id]=el.value;}}
  function selectedIds(){return [...document.querySelectorAll('.pick:checked')].map(x=>x.value);}
  function groupTracks(){const out=new Set();for(const s of catalog?.series||[])if(selectedSeriesIds.has(String(s.id)))for(const id of s.track_ids||[])out.add(String(id));for(const m of catalog?.hour_mixes||[])if(selectedMixIds.has(String(m.id)))for(const id of m.track_ids||[])out.add(String(id));return out;}
  function combinedSelection(){const out=groupTracks();for(const id of manualTrackIds)out.add(String(id));for(const id of excludedTrackIds)out.delete(String(id));return out;}
  function applySelection(){const ids=combinedSelection();document.querySelectorAll('.pick').forEach(x=>x.checked=ids.has(String(x.value)));document.querySelectorAll('.seriesPick').forEach(x=>x.checked=selectedSeriesIds.has(String(x.value)));document.querySelectorAll('.mixPick').forEach(x=>x.checked=selectedMixIds.has(String(x.value)));updateCount();}
  function updateCount(){const el=document.getElementById('selectedCount');if(el)el.textContent=`${selectedIds().length} selecionadas de ${(catalog?.tracks||[]).length} disponíveis`;const s=document.getElementById('seriesCount');if(s)s.textContent=`${selectedSeriesIds.size} série${selectedSeriesIds.size===1?'':'s'} selecionada${selectedSeriesIds.size===1?'':'s'}`;const m=document.getElementById('mixCount');if(m)m.textContent=`${selectedMixIds.size} faixa${selectedMixIds.size===1?'':'s'} longa${selectedMixIds.size===1?'':'s'} selecionada${selectedMixIds.size===1?'':'s'}`;}
  function orderedSelection(){const checked=new Set(selectedIds());return (catalog?.tracks||[]).filter(t=>checked.has(String(t.id))).map(t=>String(t.id));}
  function groupBox(type,items){const cls=type==='series'?'seriesPick':'mixPick',chosen=type==='series'?selectedSeriesIds:selectedMixIds;if(!items.length)return '<div class="tiny muted">Nenhuma opção disponível.</div>';return `<div style="display:grid;gap:6px;border:1px solid #44444a;background:#0f0f11;border-radius:10px;padding:8px;max-height:190px;overflow:auto">${items.map(x=>{const subtitle=type==='series'?`${(x.track_ids||[]).length} faixas · ${fmtDate(x.created_at||x.completed_at)}`:`${Math.round((x.duration_seconds||0)/60)} min · ${fmtDate(x.created_at||x.completed_at)}`;return `<label style="display:grid;grid-template-columns:auto 1fr;gap:9px;align-items:center;padding:9px 10px;border:1px solid #2c2c30;background:#151518;border-radius:8px;cursor:pointer"><input class="${cls}" type="checkbox" value="${esc(x.id)}" ${chosen.has(String(x.id))?'checked':''}><span><b class="small">${esc(x.name)}</b><span class="tiny muted" style="display:block;margin-top:2px">${esc(subtitle)}</span></span></label>`;}).join('')}</div>`;}

  function liveCards(){return sessions.map(s=>{const isTw=String(s.platform)==='twitch';return `<div class="card livecard" data-live="${esc(s.id)}" data-platform="${esc(s.platform)}" style="cursor:${isTw?'default':'pointer'}"><div class="row between"><div><b>${isTw?'<img src="./assets/twitch-glitch.svg" alt="Twitch" style="width:16px;height:16px;vertical-align:-3px;margin-right:6px">':platformIcon(s.platform)+' '}${esc(s.title)}</b><div class="tiny muted" style="margin-top:5px">${platformName(s.platform)} · ${fmtDate(s.created_at)} · ${s.duration_minutes===0?'contínua':`${s.duration_minutes||0} min`}</div></div><span class="pill ${esc(s.status)}">${esc(s.status)}</span></div>${s.description?`<div class="tiny muted" style="margin-top:7px">${esc(s.description)}</div>`:''}<div class="row" style="margin-top:12px">${isTw?`<a class="btn viewTwitch" href="./twitch.html">Ver Twitch / Analytics</a>`:`<button class="btn viewLive" data-id="${esc(s.id)}">Ver detalhes / Analytics</button>${['queued','starting','live','reconnecting','stopping'].includes(String(s.status))?`<button class="btn danger stopLive" data-id="${esc(s.id)}">Encerrar</button>`:''}`}</div></div>`;}).join('')||'<div class="card"><span class="small muted">Nenhuma live registrada neste backend ainda.</span></div>';}

  function render(){
    if(!API){root().innerHTML='<div class="card"><b>Backend Cloudflare ainda não implantado</b></div>';return;}
    const d=drafts[activePlatform],tracks=catalog?.tracks||[],series=catalog?.series||[],mixes=catalog?.hour_mixes||[],assets=catalog?.assets||[],images=assets.filter(a=>String(a.mime_type||'').startsWith('image/'));
    document.querySelectorAll('.platform-tabs .tab').forEach(t=>t.classList.toggle('on',t.dataset.platform===activePlatform));
    root().innerHTML=`<div class="grid grid2"><section class="card">
      <div class="row between"><div><b>Configurar live do ${platformName(activePlatform)}</b><div class="tiny muted" style="margin-top:4px">1080p60 · catálogo GitHub · controle D1 · mídia R2.</div></div><span class="pill live">${activePlatform==='youtube'?'YOUTUBE':'KICK'}</span></div>
      <div class="field"><label>TÍTULO DA LIVE</label><input id="title" class="input" value="${esc(d.title)}"></div>
      <div class="field"><label>DESCRIÇÃO</label><textarea id="description" class="input" rows="4">${esc(d.description)}</textarea><div class="tiny muted" style="margin-top:5px">${activePlatform==='kick'?'A Kick permite alterar o título da transmissão via API; a descrição permanece registrada no MediaForge.':'No YouTube, título e descrição são enviados para a transmissão.'}</div></div>
      <div class="field"><label>DURAÇÃO</label><select id="duration" class="select"><option value="0" ${d.duration==='0'?'selected':''}>Contínua</option><option value="60" ${d.duration==='60'?'selected':''}>1 hora</option><option value="120" ${d.duration==='120'?'selected':''}>2 horas</option><option value="240" ${d.duration==='240'?'selected':''}>4 horas</option><option value="480" ${d.duration==='480'?'selected':''}>8 horas</option></select></div>
      <div class="field"><label>SÉRIES / PLAYLISTS GERADAS — SELEÇÃO MÚLTIPLA</label>${groupBox('series',series)}<div id="seriesCount" class="tiny muted" style="margin-top:6px"></div></div>
      <div class="field"><label>FAIXAS LONGAS / MÚSICAS DE 1 HORA — SELEÇÃO MÚLTIPLA</label>${groupBox('mix',mixes)}<div id="mixCount" class="tiny muted" style="margin-top:6px"></div></div>
      <div class="row" style="margin-top:10px"><button id="selectAll" class="btn">Selecionar todas</button><button id="clearAll" class="btn">Limpar tudo</button><span id="selectedCount" class="tiny muted"></span></div>
      <div class="field"><label>BUSCAR MÚSICA</label><input id="trackSearch" class="input" placeholder="Buscar por nome, série ou estilo"></div>
      <div id="trackList" class="tracklist">${tracks.map(t=>`<label class="track" data-search="${esc(`${t.title} ${t.collection_name||''} ${t.style||''}`.toLowerCase())}"><input class="pick" type="checkbox" value="${esc(t.id)}"><span><b class="small">${esc(t.title)}</b><span class="tiny muted" style="display:block;margin-top:2px">${esc(t.collection_name||t.style||'Faixa')} · ${Math.round((t.duration_seconds||0)/60*10)/10} min · ${fmtDate(t.created_at||t.completed_at)}</span></span><span class="pill">${t.source==='peter_lofi_series'?'série':'faixa'}</span></label>`).join('')}</div>
    </section><aside class="grid"><section class="card">
      <b>Visual da transmissão</b><div class="tiny muted" style="margin-top:5px">Imagem = fixa. Vídeo = duração completa em loop.</div>
      <div class="field"><label>VISUAL JÁ ENVIADO</label><select id="visual" class="select"><option value="">Sem visual personalizado</option>${assets.filter(a=>a.asset_type!=='thumbnail').map(a=>`<option value="${esc(a.id)}" ${d.visual===String(a.id)?'selected':''}>${esc(a.title)} · ${fmtBytes(a.size_bytes)}</option>`).join('')}</select></div>
      <div class="field"><label class="assetdrop" for="visualFile"><b>+ Selecionar JPG, PNG, WEBP, MP4 ou MOV</b><small>O arquivo será usado como visual e repetido durante a live.</small></label><input id="visualFile" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" hidden><div class="uploadbar"><span id="uploadBar"></span></div><div id="uploadStatus" class="tiny muted" style="margin-top:7px"></div></div>
      ${activePlatform==='youtube'?`<div class="field"><label>THUMBNAIL DA LIVE NO YOUTUBE</label><select id="thumbnail" class="select"><option value="">Thumbnail padrão do Peter Lofi</option>${images.map(a=>`<option value="${esc(a.id)}" ${d.thumbnail===String(a.id)?'selected':''}>${esc(a.title)} · ${fmtBytes(a.size_bytes)}</option>`).join('')}</select></div><div class="field"><label class="assetdrop" for="thumbFile"><b>+ Enviar thumbnail JPG, PNG ou WEBP</b><small>Essa imagem será enviada como thumbnail da transmissão no YouTube.</small></label><input id="thumbFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><div class="uploadbar"><span id="thumbUploadBar"></span></div><div id="thumbUploadStatus" class="tiny muted" style="margin-top:7px"></div></div>`:''}
      <button id="start" class="btn ${activePlatform==='kick'?'kick':''} block" style="margin-top:14px">${platformIcon(activePlatform)} Iniciar no ${platformName(activePlatform)}</button>
    </section><section class="note"><b>${platformName(activePlatform)}:</b> saída fixa em 1920×1080, 60 FPS, H.264 e áudio AAC. Em lives iniciadas com o novo engine, a playlist pode ser alterada enquanto a transmissão está no ar.</section></aside></div>
    <div style="height:14px"></div><div class="row between"><b>Lives recentes</b><button id="refreshSessions" class="btn">↻ Atualizar</button></div><div class="grid" style="margin-top:10px">${liveCards()}</div>`;
    bind();applySelection();
  }

  function bind(){
    document.querySelectorAll('.seriesPick').forEach(x=>x.onchange=()=>{x.checked?selectedSeriesIds.add(String(x.value)):selectedSeriesIds.delete(String(x.value));applySelection();});
    document.querySelectorAll('.mixPick').forEach(x=>x.onchange=()=>{x.checked?selectedMixIds.add(String(x.value)):selectedMixIds.delete(String(x.value));applySelection();});
    document.querySelectorAll('.pick').forEach(x=>x.onchange=()=>{const id=String(x.value);if(x.checked){manualTrackIds.add(id);excludedTrackIds.delete(id);}else{manualTrackIds.delete(id);excludedTrackIds.add(id);}updateCount();});
    document.getElementById('selectAll').onclick=()=>{for(const t of catalog?.tracks||[])manualTrackIds.add(String(t.id));excludedTrackIds.clear();applySelection();};
    document.getElementById('clearAll').onclick=()=>{selectedSeriesIds.clear();selectedMixIds.clear();manualTrackIds.clear();excludedTrackIds.clear();applySelection();};
    document.getElementById('trackSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('#trackList .track').forEach(el=>el.style.display=!q||el.dataset.search.includes(q)?'grid':'none');};
    ['title','description','duration','visual','thumbnail'].forEach(id=>document.getElementById(id)?.addEventListener('change',captureDraft));
    document.getElementById('visualFile').onchange=e=>uploadAsset(e.target.files?.[0],'loop');
    document.getElementById('thumbFile')?.addEventListener('change',e=>uploadAsset(e.target.files?.[0],'thumbnail'));
    document.getElementById('start').onclick=startLive;document.getElementById('refreshSessions').onclick=loadSessions;
    document.querySelectorAll('.stopLive').forEach(b=>b.onclick=e=>{e.stopPropagation();stopLive(b.dataset.id)});
    document.querySelectorAll('.viewLive').forEach(b=>b.onclick=e=>{e.stopPropagation();openLive(b.dataset.id)});
    document.querySelectorAll('.livecard').forEach(c=>{if(c.dataset.platform!=='twitch')c.onclick=()=>openLive(c.dataset.live);});
  }

  async function uploadPart(assetId,uploadId,partNumber,blob,retries=3){let last;for(let i=0;i<retries;i++)try{return await api(`/api/uploads/part?asset_id=${encodeURIComponent(assetId)}&upload_id=${encodeURIComponent(uploadId)}&part_number=${partNumber}`,{method:'PUT',body:blob,headers:{'content-type':'application/octet-stream'}})}catch(e){last=e;await new Promise(r=>setTimeout(r,1000*(i+1)));}throw last;}
  async function uploadAsset(file,kind){if(!file)return;const isThumb=kind==='thumbnail',status=document.getElementById(isThumb?'thumbUploadStatus':'uploadStatus'),bar=document.getElementById(isThumb?'thumbUploadBar':'uploadBar'),btn=document.getElementById('start');btn.disabled=true;bar.style.width='0%';status.textContent=`${file.name} · ${fmtBytes(file.size)} · preparando upload…`;let init=null;try{init=await api('/api/uploads/init',{method:'POST',body:JSON.stringify({name:file.name,title:file.name,mime_type:file.type||'application/octet-stream',size_bytes:file.size,asset_type:kind})});const chunk=Number(init.chunk_size||50*1024*1024),count=Math.ceil(file.size/chunk),results=new Array(count);let done=0,next=0;async function worker(){while(true){const idx=next++;if(idx>=count)return;const start=idx*chunk,end=Math.min(file.size,start+chunk),blob=file.slice(start,end),p=await uploadPart(init.asset_id,init.upload_id,idx+1,blob);results[idx]=p;done+=blob.size;const pct=Math.round(done/file.size*100);bar.style.width=`${pct}%`;status.textContent=`${file.name} · ${pct}%`;}}await Promise.all(Array.from({length:Math.min(3,count)},()=>worker()));const completed=await api('/api/uploads/complete',{method:'POST',body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id,parts:results})}),asset=completed.asset;catalog.assets=[asset,...(catalog.assets||[]).filter(a=>a.id!==asset.id)];drafts[activePlatform][isThumb?'thumbnail':'visual']=String(asset.id);render();const s=document.getElementById(isThumb?'thumbUploadStatus':'uploadStatus');if(s)s.textContent=`✓ ${file.name} selecionado.`;}catch(e){if(init)try{await api('/api/uploads/abort',{method:'POST',body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id})})}catch(_){}if(status){status.textContent=`Falha no upload: ${e.message}`;status.style.color='#ff9ca6';}bar.style.width='0%';}finally{const b=document.getElementById('start');if(b)b.disabled=false;}}

  async function waitForLiveConfirmation(id,platform,btn){
    const started=Date.now(),timeout=120000;
    while(Date.now()-started<timeout){
      await new Promise(r=>setTimeout(r,3000));
      const detail=await api(`/api/live/${encodeURIComponent(id)}`);
      const st=String(detail?.session?.status||'').toLowerCase();
      if(btn)btn.textContent=st==='queued'?'Na fila…':st==='starting'?'Conectando encoder…':st==='reconnecting'?'Reconectando…':'Confirmando live…';
      if(st==='live')return detail;
      if(st==='failed'||st==='completed')throw new Error(detail?.session?.error_message||`A live terminou com status ${st} antes de ficar online.`);
    }
    return null;
  }

  async function startLive(){
    captureDraft();
    const btn=document.getElementById('start'),ids=orderedSelection(),d=drafts[activePlatform],platformAtStart=activePlatform;
    if(!ids.length){alert('Selecione pelo menos uma música, série ou faixa longa.');return;}
    btn.disabled=true;btn.textContent='Enviando comando…';
    try{
      const launch=await api('/api/live/start',{method:'POST',body:JSON.stringify({platform:platformAtStart,track_ids:ids,duration_minutes:Number(d.duration||0),title:d.title.trim(),description:d.description,visual_asset_id:d.visual||null,thumbnail_asset_id:platformAtStart==='youtube'?(d.thumbnail||null):null})});
      const id=launch?.session?.id;
      if(!id)throw new Error('O MediaForge não retornou o ID da sessão.');
      btn.textContent='Inicializando encoder…';
      await loadSessions();
      const confirmed=await waitForLiveConfirmation(id,platformAtStart,btn);
      await loadSessions();
      if(confirmed){
        alert(`✓ Live do ${platformName(platformAtStart)} confirmada e online.`);
      }else{
        alert(`A live do ${platformName(platformAtStart)} foi iniciada e continua sendo verificada. Ela aparecerá como AO VIVO assim que o encoder for confirmado.`);
      }
    }catch(e){
      await loadSessions().catch(()=>{});
      alert('Falha ao iniciar: '+e.message);
    }finally{
      btn.disabled=false;btn.textContent=`${platformIcon(platformAtStart)} Iniciar no ${platformName(platformAtStart)}`;
    }
  }
  async function stopLive(id){if(!confirm('Encerrar esta live agora?'))return;try{await api(`/api/live/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});closeModal();await loadSessions();}catch(e){alert('Falha ao encerrar: '+e.message);}}

  function closeModal(){document.getElementById('liveModal')?.remove();}
  function analyticsHtml(d){const a=d.analytics||{};if(d.session.platform==='kick'){const ch=a.channel||{},st=ch.stream||{};return `<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:8px"><div class="card"><div class="tiny muted">ONLINE</div><b>${st.is_live?'SIM':'NÃO'}</b></div><div class="card"><div class="tiny muted">ESPECTADORES</div><b>${esc(st.viewer_count??'—')}</b></div><div class="card"><div class="tiny muted">INSCRITOS ATIVOS</div><b>${esc(ch.active_subscribers_count??'—')}</b></div><div class="card"><div class="tiny muted">CATEGORIA</div><b>${esc(ch.category?.name||'—')}</b></div></div>`;}const item=a.data||{},live=item.liveStreamingDetails||{},stats=item.statistics||{};return `<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:8px"><div class="card"><div class="tiny muted">CONCORRENTES</div><b>${esc(live.concurrentViewers??'—')}</b></div><div class="card"><div class="tiny muted">VISUALIZAÇÕES</div><b>${esc(stats.viewCount??'—')}</b></div><div class="card"><div class="tiny muted">LIKES</div><b>${esc(stats.likeCount??'—')}</b></div><div class="card"><div class="tiny muted">STATUS</div><b>${esc(item.snippet?.liveBroadcastContent||d.session.status)}</b></div></div>`;}

  async function openLive(id){closeModal();const wrap=document.createElement('div');wrap.id='liveModal';wrap.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;padding:22px';wrap.innerHTML='<div class="card" style="width:min(980px,96vw);max-height:90vh;overflow:auto"><b>Carregando live…</b></div>';document.body.appendChild(wrap);wrap.onclick=e=>{if(e.target===wrap)closeModal()};try{const d=await api(`/api/live/${encodeURIComponent(id)}`),s=d.session,selected=new Set((s.track_ids||[]).map(String)),tracks=catalog?.tracks||[];wrap.innerHTML=`<div class="card" style="width:min(1050px,96vw);max-height:90vh;overflow:auto"><div class="row between"><div><b style="font-size:18px">${platformIcon(s.platform)} ${esc(s.title)}</b><div class="tiny muted" style="margin-top:5px">${platformName(s.platform)} · ${fmtDate(s.created_at)} · ${esc(s.status)}</div></div><button id="closeLiveModal" class="btn">✕ Fechar</button></div><div style="height:14px"></div>${analyticsHtml(d)}<div class="card" style="margin-top:10px"><div class="row between"><div><b>Transmissão</b><div class="tiny muted" style="margin-top:4px">${esc(s.encoder_resolution||'1920x1080')} · ${esc(s.encoder_fps||60)} FPS · ${esc(s.encoder_bitrate_kbps||8000)} kbps</div></div>${s.github_run_url?`<a class="btn" target="_blank" href="${esc(s.github_run_url)}">Abrir GitHub Run</a>`:''}</div>${d.now_playing?`<div class="note" style="margin-top:10px"><b>Tocando agora:</b> ${esc(d.now_playing.title||d.now_playing.track_id)} · desde ${fmtDate(d.now_playing.started_at)}</div>`:'<div class="tiny muted" style="margin-top:10px">A faixa atual aparecerá aqui nas lives iniciadas pelo novo engine.</div>'}</div><div class="card" style="margin-top:10px"><div class="row between"><div><b>Músicas da live</b><div class="tiny muted" style="margin-top:4px">Adicione ou remova faixas. A alteração entra após a faixa atual terminar.</div></div><span id="detailCount" class="pill">${selected.size} faixas</span></div><input id="detailSearch" class="input" style="margin-top:10px" placeholder="Buscar música"><div id="detailTracks" class="tracklist" style="max-height:320px">${tracks.map(t=>`<label class="track detailTrack" data-search="${esc(`${t.title} ${t.collection_name||''} ${t.style||''}`.toLowerCase())}"><input class="detailPick" type="checkbox" value="${esc(t.id)}" ${selected.has(String(t.id))?'checked':''}><span><b class="small">${esc(t.title)}</b><span class="tiny muted" style="display:block">${esc(t.collection_name||t.style||'Faixa')}</span></span><span class="tiny muted">${Math.round((t.duration_seconds||0)/60*10)/10} min</span></label>`).join('')}</div><div class="row" style="margin-top:10px"><button id="saveLiveTracks" class="btn">Salvar nova playlist</button>${['queued','starting','live','reconnecting','stopping'].includes(String(s.status))?`<button id="modalStop" class="btn danger">Encerrar live</button>`:''}</div></div><div class="tiny muted" style="margin-top:10px">Analytics atualizados: ${d.analytics_generated_at?fmtDate(d.analytics_generated_at):'ainda aguardando primeira coleta'}.</div></div>`;document.getElementById('closeLiveModal').onclick=closeModal;document.getElementById('detailSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('.detailTrack').forEach(x=>x.style.display=!q||x.dataset.search.includes(q)?'grid':'none')};document.querySelectorAll('.detailPick').forEach(x=>x.onchange=()=>{const n=document.querySelectorAll('.detailPick:checked').length;document.getElementById('detailCount').textContent=`${n} faixas`;});document.getElementById('saveLiveTracks').onclick=async()=>{const ids=[...document.querySelectorAll('.detailPick:checked')].map(x=>x.value);if(!ids.length){alert('A live precisa manter pelo menos uma música.');return;}const b=document.getElementById('saveLiveTracks');b.disabled=true;b.textContent='Salvando…';try{await api(`/api/live/${encodeURIComponent(id)}/tracks`,{method:'PATCH',body:JSON.stringify({track_ids:ids})});alert('Playlist atualizada. A nova seleção entra após a faixa atual terminar.');await loadSessions();await openLive(id);}catch(e){alert('Falha ao atualizar playlist: '+e.message);}finally{b.disabled=false;b.textContent='Salvar nova playlist';}};document.getElementById('modalStop')?.addEventListener('click',()=>stopLive(id));}catch(e){wrap.innerHTML=`<div class="card"><b>Falha ao carregar a live</b><div class="small muted" style="margin-top:7px">${esc(e.message)}</div><button class="btn" style="margin-top:10px" onclick="document.getElementById('liveModal')?.remove()">Fechar</button></div>`;}}

  async function loadSessions(){try{captureDraft();const x=await api('/api/live-sessions');sessions=await mergeTwitchSession(x.sessions||[]);render();}catch(e){console.error(e);}}
  async function load(){if(loading)return;loading=true;try{if(!API){render();return;}await api('/api/me');const [c,ls]=await Promise.all([api('/api/catalog'),api('/api/live-sessions')]);catalog=c;sessions=await mergeTwitchSession(ls.sessions||[]);render();}catch(e){root().innerHTML=`<div class="card" style="color:#ffb2ba"><b>Falha ao carregar o MediaForge</b><div class="small" style="margin-top:7px">${esc(e.message)}</div><button class="btn" style="margin-top:12px" onclick="location.reload()">↻ Tentar novamente</button></div>`;}finally{loading=false;}}
  document.querySelectorAll('.platform-tabs .tab').forEach(tab=>tab.onclick=()=>{captureDraft();activePlatform=tab.dataset.platform||'kick';render();});
  document.getElementById('refresh')?.addEventListener('click',load);load();setInterval(()=>{if(document.visibilityState==='visible'&&catalog)loadSessions();},15000);
})();
