(()=>{
  const API=(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'').replace(/\/$/,'');
  const TOKEN_KEY='mediaforge_token';
  const TWITCH_RAW='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control';
  const requestedPlatform=new URLSearchParams(location.search).get('platform');
  let catalog=null,musicLibrary={playlists:[]},sessions=[],ovh=null,djScan=null,loading=false,activePlatform=['youtube','kick','twitch'].includes(requestedPlatform)?requestedPlatform:'kick';
  const selectedSeriesIds=new Set(),selectedMixIds=new Set(),manualTrackIds=new Set(),excludedTrackIds=new Set();
  const drafts={
    kick:{title:'Peter Lofi Gaming Radio 🎮 Lofi Beats to Play, Focus & Chill 🔴 LIVE',description:'',duration:'0',visual:'',thumbnail:'',playlist:'gaming-radio'},
    twitch:{title:'Peter Lofi Gaming Radio 🎮 Lofi Beats to Play, Focus & Chill 🔴 LIVE',description:'',duration:'0',visual:'',thumbnail:'',playlist:'twitch-dj-mixed'},
    youtube:{title:'Peter Lofi Radio 🎧 Lofi Beats for Work, Study, Focus & Relax 🔴 Live',description:'Lofi beats for work, study, focus and relaxation. Live on Peter Lofi.',duration:'0',visual:'',thumbnail:'',playlist:'deep-house-radio'}
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

  function captureDraft(){const d=drafts[activePlatform],ids=['title','description','duration','visual','thumbnail','playlist'];for(const id of ids){const el=document.getElementById(id);if(el)d[id]=el.value;}}
  function selectedIds(){return [...document.querySelectorAll('.pick:checked')].map(x=>x.value);}
  function groupTracks(){const out=new Set();for(const s of catalog?.series||[])if(selectedSeriesIds.has(String(s.id)))for(const id of s.track_ids||[])out.add(String(id));for(const m of catalog?.hour_mixes||[])if(selectedMixIds.has(String(m.id)))for(const id of m.track_ids||[])out.add(String(id));return out;}
  function combinedSelection(){const out=groupTracks();for(const id of manualTrackIds)out.add(String(id));for(const id of excludedTrackIds)out.delete(String(id));return out;}
  function applySelection(){const ids=combinedSelection();document.querySelectorAll('.pick').forEach(x=>x.checked=ids.has(String(x.value)));document.querySelectorAll('.seriesPick').forEach(x=>x.checked=selectedSeriesIds.has(String(x.value)));document.querySelectorAll('.mixPick').forEach(x=>x.checked=selectedMixIds.has(String(x.value)));updateCount();}
  function updateCount(){const el=document.getElementById('selectedCount');if(el)el.textContent=`${selectedIds().length} selecionadas de ${(catalog?.tracks||[]).length} disponíveis`;const s=document.getElementById('seriesCount');if(s)s.textContent=`${selectedSeriesIds.size} série${selectedSeriesIds.size===1?'':'s'} selecionada${selectedSeriesIds.size===1?'':'s'}`;const m=document.getElementById('mixCount');if(m)m.textContent=`${selectedMixIds.size} faixa${selectedMixIds.size===1?'':'s'} longa${selectedMixIds.size===1?'':'s'} selecionada${selectedMixIds.size===1?'':'s'}`;}
  function orderedSelection(){const checked=new Set(selectedIds());return (catalog?.tracks||[]).filter(t=>checked.has(String(t.id))).map(t=>String(t.id));}
  function groupBox(type,items){const cls=type==='series'?'seriesPick':'mixPick',chosen=type==='series'?selectedSeriesIds:selectedMixIds;if(!items.length)return '<div class="tiny muted">Nenhuma opção disponível.</div>';return `<div style="display:grid;gap:6px;border:1px solid #44444a;background:#0f0f11;border-radius:10px;padding:8px;max-height:190px;overflow:auto">${items.map(x=>{const subtitle=type==='series'?`${(x.track_ids||[]).length} faixas · ${fmtDate(x.created_at||x.completed_at)}`:`${Math.round((x.duration_seconds||0)/60)} min · ${fmtDate(x.created_at||x.completed_at)}`;return `<label style="display:grid;grid-template-columns:auto 1fr;gap:9px;align-items:center;padding:9px 10px;border:1px solid #2c2c30;background:#151518;border-radius:8px;cursor:pointer"><input class="${cls}" type="checkbox" value="${esc(x.id)}" ${chosen.has(String(x.id))?'checked':''}><span><b class="small">${esc(x.name)}</b><span class="tiny muted" style="display:block;margin-top:2px">${esc(subtitle)}</span></span></label>`;}).join('')}</div>`;}

  function liveCards(){
    const filtered=sessions.filter(s=>String(s.platform)===activePlatform);
    return filtered.map(s=>`<div class="card livecard" data-live="${esc(s.id)}" data-platform="${esc(s.platform)}" style="cursor:pointer"><div class="row between"><div><b>${platformIcon(s.platform)} ${esc(s.title)}</b><div class="tiny muted" style="margin-top:5px">${platformName(s.platform)} · ${s.runtime==='ovh'?'<span style="color:#8ff2bb">OVH</span> · ':''}${fmtDate(s.created_at||s.live_at)} · ${Number(s.duration_minutes||0)===0?'contínua':`${s.duration_minutes||0} min`}</div></div><span class="pill ${esc(s.status)}">${esc(String(s.status)==='live'?'AO VIVO':String(s.status||'').toUpperCase())}</span></div>${s.description?`<div class="tiny muted" style="margin-top:7px">${esc(s.description)}</div>`:''}<div class="row" style="margin-top:12px"><button class="btn viewLive" data-id="${esc(s.id)}">Ver detalhes / Analytics</button>${['queued','starting','live','reconnecting','stopping'].includes(String(s.status))?`<button class="btn danger stopLive" data-id="${esc(s.id)}">Encerrar</button>`:''}</div></div>`).join('')||'<div class="card"><span class="small muted">Nenhuma live registrada nesta plataforma ainda.</span></div>';
  }

  function canonicalPlaylistOptions(selected=''){
    const list=(musicLibrary?.playlists||[]).filter(p=>{const allowed=Array.isArray(p.allowed_platforms)?p.allowed_platforms.map(x=>String(x).toLowerCase()):[];return !allowed.length||allowed.includes(activePlatform);});
    return list.map(p=>`<option value="${esc(p.key)}" ${String(selected)===String(p.key)?'selected':''}>${esc(p.name)} · ${esc(p.track_count||0)} faixas · ${esc(p.genre||'Lofi')}</option>`).join('');
  }

  function djScannerCard(){
    if(activePlatform!=='twitch')return '';
    const s=djScan||null,total=Number(s?.total||215),processed=Number(s?.processed||0),pct=total?Math.round(processed/total*100):0;
    const status=s?String(s.status||'pending'):'not_started';
    const statusLabel=status==='completed'?'Concluído':status==='running'?'Verificando':status==='pending'?'Aguardando':'Não iniciado';
    return `<section class="card" style="margin-top:14px;border-color:#4a356d">
      <div class="row between wrap"><div><b>DJ Music Catalog Scanner</b><div class="tiny muted" style="margin-top:4px">Cruza a lista selecionada com o catálogo oficial da Twitch usando sua sessão DJ no navegador.</div></div><span class="pill ${status==='completed'?'live':'queued'}">${esc(statusLabel)}</span></div>
      <div class="grid" style="grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:12px">
        <div class="card"><div class="tiny muted">PROCESSADAS</div><b>${processed}/${total}</b></div>
        <div class="card"><div class="tiny muted">ALLOWED</div><b style="color:#8ff2bb">${Number(s?.allowed||0)}</b></div>
        <div class="card"><div class="tiny muted">RESTRICTED</div><b style="color:#ff9ca6">${Number(s?.restricted||0)}</b></div>
        <div class="card"><div class="tiny muted">NÃO ENCONTRADAS</div><b>${Number(s?.not_found||0)}</b></div>
        <div class="card"><div class="tiny muted">REVISAR</div><b>${Number(s?.ambiguous||0)+Number(s?.error_count||0)}</b></div>
      </div>
      <div style="height:7px;background:#29292e;border-radius:999px;overflow:hidden;margin-top:10px"><span style="display:block;height:100%;width:${pct}%;background:#9146ff"></span></div>
      <div class="row wrap" style="margin-top:12px">
        <a class="btn" href="./twitch-dj-catalog-scanner.user.js?v=20261004-111" target="_blank" rel="noopener">1. Instalar scanner</a>
        <button id="startDjCatalogScan" class="btn twitch">2. Verificar 100 novas</button><button id="startDjCatalogLegacy" class="btn">Lista anterior (215)</button>
        ${s?.id?'<button id="refreshDjCatalogScan" class="btn">↻ Atualizar resultado</button>':''}<a class="btn twitch" href="./twitch-dj-upload.html">3. Enviar ZIP MP3</a>
      </div>
      <div class="tiny muted" style="margin-top:9px">A sessão OAuth/cookies da Twitch não é enviada ao MediaForge. O script roda dentro de twitch.tv e envia apenas o resultado de cada faixa.</div>
    </section>`;
  }

  function youtubeSlotOptions(){
    const list=ovh?.youtube_slots||[];
    if(!list.length)return '<option value="">Slots OVH ainda não sincronizados</option>';
    return list.map(st=>{const slot=String(st.ovh_slot||''),busy=!!st.current_session_id&&['live','starting'].includes(String(st.status||''));return `<option value="${esc(slot)}" ${busy?'disabled':''}>${esc(st.name||slot)} · ${busy?'ocupado':'livre'}</option>`}).join('');
  }

  function render(){
    if(!API){root().innerHTML='<div class="card"><b>Backend Cloudflare ainda não implantado</b></div>';return;}
    const d=drafts[activePlatform],tracks=catalog?.tracks||[],series=catalog?.series||[],mixes=catalog?.hour_mixes||[],playlists=musicLibrary?.playlists||[],assets=catalog?.assets||[],images=assets.filter(a=>String(a.mime_type||'').startsWith('image/'));
    document.querySelectorAll('.platform-tabs .tab').forEach(t=>t.classList.toggle('on',t.dataset.platform===activePlatform));
    root().innerHTML=`<div class="grid grid2"><section class="card">
      <div class="row between"><div><b>Configurar live do ${platformName(activePlatform)}</b><div class="tiny muted" style="margin-top:4px">Encoder OVH · catálogo GitHub · controle D1 · mídia R2.</div></div><span class="pill live">${activePlatform.toUpperCase()}</span></div>
      <div class="field"><label>TÍTULO DA LIVE</label><input id="title" class="input" value="${esc(d.title)}"></div>
      <div class="field"><label>DESCRIÇÃO</label><textarea id="description" class="input" rows="4">${esc(d.description)}</textarea><div class="tiny muted" style="margin-top:5px">${activePlatform==='kick'?'A Kick permite alterar o título da transmissão via API; a descrição permanece registrada no MediaForge.':'No YouTube, título e descrição são enviados para a transmissão.'}</div></div>
      <div class="field"><label>DURAÇÃO</label><select id="duration" class="select"><option value="0" ${d.duration==='0'?'selected':''}>Contínua</option><option value="60" ${d.duration==='60'?'selected':''}>1 hora</option><option value="120" ${d.duration==='120'?'selected':''}>2 horas</option><option value="240" ${d.duration==='240'?'selected':''}>4 horas</option><option value="480" ${d.duration==='480'?'selected':''}>8 horas</option></select></div>
      ${activePlatform==='youtube'?`<div class="field"><label>SLOT OVH DO YOUTUBE</label><select id="youtubeSlot" class="select"><option value="">Selecione um slot disponível</option>${youtubeSlotOptions()}</select><div class="tiny muted" style="margin-top:5px">Cada live simultânea do YouTube usa um stream reutilizável provisionado na VPS.</div></div>`:''}
      <div class="field"><label>PLAYLIST DE MÚSICA</label><select id="playlist" class="select"><option value="">Selecione uma playlist</option>${canonicalPlaylistOptions(d.playlist)}</select><div class="tiny muted" style="margin-top:6px">As lives rodam faixa por faixa. Ao terminar todas as músicas, a playlist continua novamente em shuffle sem compartilhar posição com as outras plataformas.</div></div>
      <div id="playlistSummary" class="note">${(()=>{const p=playlists.find(x=>String(x.key)===String(d.playlist));return p?`<b>${esc(p.name)}</b> · ${esc(p.track_count)} faixas · ${esc(p.genre||'Lofi')}`:'Escolha uma playlist do catálogo PeterLofi.'})()}</div>
    </section><aside class="grid"><section class="card">
      <b>Visual da transmissão</b><div class="tiny muted" style="margin-top:5px">Imagem = fixa. Vídeo = duração completa em loop.</div>
      <div class="field"><label>VISUAL JÁ ENVIADO</label><select id="visual" class="select"><option value="">Sem visual personalizado</option>${assets.filter(a=>a.asset_type!=='thumbnail').map(a=>`<option value="${esc(a.id)}" ${d.visual===String(a.id)?'selected':''}>${esc(a.title)} · ${fmtBytes(a.size_bytes)}</option>`).join('')}</select></div>
      <div class="field"><label class="assetdrop" for="visualFile"><b>+ Selecionar JPG, PNG, WEBP, MP4 ou MOV</b><small>O arquivo será usado como visual e repetido durante a live.</small></label><input id="visualFile" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" hidden><div class="uploadbar"><span id="uploadBar"></span></div><div id="uploadStatus" class="tiny muted" style="margin-top:7px"></div></div>
      ${activePlatform==='youtube'?`<div class="field"><label>THUMBNAIL DA LIVE NO YOUTUBE</label><select id="thumbnail" class="select"><option value="">Thumbnail padrão do Peter Lofi</option>${images.map(a=>`<option value="${esc(a.id)}" ${d.thumbnail===String(a.id)?'selected':''}>${esc(a.title)} · ${fmtBytes(a.size_bytes)}</option>`).join('')}</select></div><div class="field"><label class="assetdrop" for="thumbFile"><b>+ Enviar thumbnail JPG, PNG ou WEBP</b><small>Essa imagem será enviada como thumbnail da transmissão no YouTube.</small></label><input id="thumbFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><div class="uploadbar"><span id="thumbUploadBar"></span></div><div id="thumbUploadStatus" class="tiny muted" style="margin-top:7px"></div></div>`:''}
      <button id="start" class="btn ${activePlatform==='kick'?'kick':activePlatform==='twitch'?'twitch':''} block" style="margin-top:14px">${platformIcon(activePlatform)} Iniciar no ${platformName(activePlatform)}</button>
    </section><section class="note"><b>${platformName(activePlatform)} via OVH:</b> o MediaForge envia o comando para a VPS e o encoder permanece 24/7 fora do GitHub Actions. A playlist pode ser alterada enquanto a transmissão está no ar.</section></aside></div>` + djScannerCard() + `<div style="height:14px"></div><div class="row between"><b>Lives recentes</b><button id="refreshSessions" class="btn">↻ Atualizar</button></div><div class="grid" style="margin-top:10px">${liveCards()}</div>`;
    bind();applySelection();
  }

  function bind(){
    ['title','description','duration','visual','thumbnail','playlist'].forEach(id=>document.getElementById(id)?.addEventListener('change',()=>{captureDraft();if(id==='playlist')render();}));
    document.getElementById('visualFile')?.addEventListener('change',e=>uploadAsset(e.target.files?.[0],'loop'));
    document.getElementById('thumbFile')?.addEventListener('change',e=>uploadAsset(e.target.files?.[0],'thumbnail'));
    document.getElementById('start').onclick=startLive;
    document.getElementById('refreshSessions').onclick=loadSessions;
    document.getElementById('startDjCatalogScan')?.addEventListener('click',()=>startDjCatalogScan('dance100'));
    document.getElementById('startDjCatalogLegacy')?.addEventListener('click',()=>startDjCatalogScan('gaming'));
    document.getElementById('refreshDjCatalogScan')?.addEventListener('click',loadDjScan);
    document.querySelectorAll('.stopLive').forEach(b=>b.onclick=e=>{e.stopPropagation();stopLive(b.dataset.id)});
    document.querySelectorAll('.viewLive').forEach(b=>b.onclick=e=>{e.stopPropagation();openLive(b.dataset.id)});
    document.querySelectorAll('.livecard').forEach(card=>card.onclick=()=>openLive(card.dataset.live));
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
    const btn=document.getElementById('start'),d=drafts[activePlatform],platformAtStart=activePlatform,playlistKey=document.getElementById('playlist')?.value||d.playlist||'';
    if(!playlistKey){alert('Selecione uma playlist de música.');return;}
    btn.disabled=true;btn.textContent='Enviando comando…';
    try{
      const youtubeSlot=platformAtStart==='youtube'?(document.getElementById('youtubeSlot')?.value||''):null;
      if(platformAtStart==='youtube'&&!youtubeSlot)throw new Error('Selecione um slot OVH do YouTube que esteja livre.');
      const launch=await api('/api/live/start',{method:'POST',body:JSON.stringify({platform:platformAtStart,playlist_key:playlistKey,duration_minutes:Number(d.duration||0),title:d.title.trim(),description:d.description,visual_asset_id:d.visual||null,thumbnail_asset_id:platformAtStart==='youtube'?(d.thumbnail||null):null,youtube_slot:youtubeSlot})});
      const id=launch?.session?.id;
      if(!id)throw new Error('O MediaForge não retornou o ID da sessão.');
      btn.textContent='Inicializando encoder…';
      await loadSessions();
      const confirmed=await waitForLiveConfirmation(id,platformAtStart,btn);
      await loadSessions();
      alert(confirmed?`✓ Live do ${platformName(platformAtStart)} confirmada e online.`:`A live do ${platformName(platformAtStart)} foi iniciada e continua sendo verificada.`);
    }catch(e){
      await loadSessions().catch(()=>{});
      alert('Falha ao iniciar: '+e.message);
    }finally{
      btn.disabled=false;btn.textContent=`${platformIcon(platformAtStart)} Iniciar no ${platformName(platformAtStart)}`;
    }
  }
  async function stopLive(id){if(!confirm('Encerrar esta live agora?'))return;try{await api(`/api/live/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});closeModal();await loadSessions();}catch(e){alert('Falha ao encerrar: '+e.message);}}

  function closeModal(){document.getElementById('liveModal')?.remove();}
  function analyticsHtml(d){
    const a=d.analytics||{},svc=d.ovh_service||{};
    if(d.session.platform==='kick'){const ch=a.channel||{},st=ch.stream||{};return `<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:8px"><div class="card"><div class="tiny muted">RUNTIME</div><b>OVH</b></div><div class="card"><div class="tiny muted">ESPECTADORES</div><b>${esc(st.viewer_count??'—')}</b></div><div class="card"><div class="tiny muted">RESTARTS</div><b>${esc(svc.restarts??0)}</b></div><div class="card"><div class="tiny muted">BITRATE</div><b>${esc(svc.video_bitrate_kbps??'—')} kbps</b></div></div>`;}
    if(d.session.platform==='twitch')return `<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:8px"><div class="card"><div class="tiny muted">RUNTIME</div><b>OVH</b></div><div class="card"><div class="tiny muted">ENCODER</div><b>${esc(svc.status||d.session.status)}</b></div><div class="card"><div class="tiny muted">RESTARTS</div><b>${esc(svc.restarts??0)}</b></div><div class="card"><div class="tiny muted">BITRATE</div><b>${esc(svc.video_bitrate_kbps??'—')} kbps</b></div></div>`;
    const item=a.data||{},live=item.liveStreamingDetails||{},stats=item.statistics||{};return `<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:8px"><div class="card"><div class="tiny muted">CONCORRENTES</div><b>${esc(live.concurrentViewers??'—')}</b></div><div class="card"><div class="tiny muted">VISUALIZAÇÕES</div><b>${esc(stats.viewCount??'—')}</b></div><div class="card"><div class="tiny muted">OVH</div><b>${esc(svc.status||d.session.status)}</b></div><div class="card"><div class="tiny muted">RESTARTS</div><b>${esc(svc.restarts??0)}</b></div></div>`;
  }

  async function openLive(id){
    closeModal();
    const wrap=document.createElement('div');wrap.id='liveModal';wrap.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;padding:22px';
    wrap.innerHTML='<div class="card" style="width:min(980px,96vw);max-height:90vh;overflow:auto"><b>Carregando live…</b></div>';
    document.body.appendChild(wrap);wrap.onclick=e=>{if(e.target===wrap)closeModal()};
    try{
      const d=await api(`/api/live/${encodeURIComponent(id)}`),s=d.session,slot=s.runtime_slot||d.ovh_service?.runtime_slot||s.platform;
      const currentPlaylist=d.ovh_service?.playlist_key||'';const options=canonicalPlaylistOptions(currentPlaylist);
      wrap.innerHTML=`<div class="card" style="width:min(980px,96vw);max-height:90vh;overflow:auto"><div class="row between"><div><b style="font-size:18px">${platformIcon(s.platform)} ${esc(s.title)}</b><div class="tiny muted" style="margin-top:5px">${platformName(s.platform)} · OVH · ${esc(s.status)}</div></div><button id="closeLiveModal" class="btn">✕ Fechar</button></div><div style="height:14px"></div>${analyticsHtml(d)}
      <div class="card" style="margin-top:10px"><div class="row between wrap"><div><b>Tocando agora</b><div class="tiny muted" style="margin-top:4px">${d.now_playing?esc(d.now_playing.title||d.now_playing.track_id):'Aguardando informação do encoder'}</div></div><div class="row"><button id="prevTrack" class="btn">↶ Anterior</button><button id="nextTrack" class="btn">↷ Próxima</button></div></div></div>
      <div class="card" style="margin-top:10px"><b>Playlist da live</b><div class="tiny muted" style="margin-top:4px">Atual: ${esc((musicLibrary?.playlists||[]).find(p=>p.key===currentPlaylist)?.name||currentPlaylist||'não identificada')} · Trocar a playlist afeta somente esta plataforma. A música atual é interrompida e uma faixa da nova playlist começa.</div><div class="row wrap" style="margin-top:10px"><select id="livePlaylistSelect" class="select" style="flex:1;min-width:260px"><option value="">Selecione uma playlist</option>${options}</select><button id="applyLivePlaylist" class="btn primary">Aplicar playlist</button></div></div>
      <div class="row" style="margin-top:12px">${['queued','starting','live','reconnecting','stopping'].includes(String(s.status))?`<button id="modalStop" class="btn danger">Encerrar live</button>`:''}</div></div>`;
      document.getElementById('closeLiveModal').onclick=closeModal;
      document.getElementById('nextTrack').onclick=()=>sendTrackControl(id,slot,'skip');
      document.getElementById('prevTrack').onclick=()=>sendTrackControl(id,slot,'previous');
      document.getElementById('applyLivePlaylist').onclick=async()=>{const playlistKey=document.getElementById('livePlaylistSelect').value;if(!playlistKey){alert('Selecione uma playlist.');return;}const b=document.getElementById('applyLivePlaylist');b.disabled=true;b.textContent='Aplicando…';try{await api('/api/ovh/playlist',{method:'POST',body:JSON.stringify({runtime_slot:slot,session_id:id,playlist_key:playlistKey})});setTimeout(()=>openLive(id),2200)}catch(e){alert('Falha ao trocar playlist: '+e.message);b.disabled=false;b.textContent='Aplicar playlist';}};
      document.getElementById('modalStop')?.addEventListener('click',()=>stopLive(id));
    }catch(e){wrap.innerHTML=`<div class="card"><b>Falha ao carregar a live</b><div class="small muted" style="margin-top:7px">${esc(e.message)}</div><button class="btn" style="margin-top:10px" onclick="document.getElementById('liveModal')?.remove()">Fechar</button></div>`;}
  }

  async function waitOvhControl(commandId,timeoutMs=15000){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      await new Promise(r=>setTimeout(r,450));
      const x=await api('/api/ovh/control/'+encodeURIComponent(commandId));
      const st=String(x?.command?.status||'');
      if(st==='completed')return {...x.command,confirmed:true};
      if(st==='failed'||st==='cancelled')throw new Error(x?.command?.error||('Comando '+st));
    }
    // The OVH agent also consumes the GitHub mirror of every music command.
    // A missing Cloudflare ACK must not make a working fallback look broken.
    return {id:commandId,status:'dispatched',confirmed:false};
  }

  async function sendTrackControl(id,slot,action){
    const btn=action==='previous'?document.getElementById('prevTrack'):document.getElementById('nextTrack');
    const original=action==='previous'?'↶ Anterior':'↷ Próxima';
    try{
      const x=await api('/api/ovh/control',{method:'POST',body:JSON.stringify({action,runtime_slot:slot,session_id:id})});
      const commandId=x?.command?.id;
      if(!commandId)throw new Error('O MediaForge não retornou o ID do comando.');
      if(btn){
        const n=Number(btn.dataset.queued||0)+1;
        btn.dataset.queued=String(n);
        btn.textContent=(action==='previous'?'↶':'↷')+' Na fila ('+n+')';
        setTimeout(()=>{
          const left=Math.max(0,Number(btn.dataset.queued||1)-1);
          btn.dataset.queued=String(left);
          btn.textContent=left?((action==='previous'?'↶':'↷')+' Na fila ('+left+')'):original;
        },2200);
      }
      // Wait briefly for the OVH ACK. The command remains durable even if the
      // ACK is delayed because it also has an independent GitHub fallback.
      const ack=await waitOvhControl(commandId,12000);
      if(btn){
        btn.dataset.queued='0';
        btn.textContent=ack.confirmed?'✓ Aplicado':original;
        setTimeout(()=>{if(btn)btn.textContent=original;},1200);
      }
      setTimeout(()=>openLive(id),900);
    }catch(e){
      alert('Falha no controle da música: '+e.message);
      if(btn){btn.dataset.queued='0';btn.textContent=original;}
    }
  }

  async function loadDjScan(){
    try{
      const x=await api('/api/dj-catalog/scans?limit=1');
      djScan=(x.scans||[])[0]||null;
      if(activePlatform==='twitch')render();
    }catch(e){console.warn('DJ catalog scan status:',e)}
  }
  async function startDjCatalogScan(source='dance100'){
    const isNew=source==='dance100',btn=document.getElementById(isNew?'startDjCatalogScan':'startDjCatalogLegacy');
    if(btn){btn.disabled=true;btn.textContent='Preparando scanner…';}
    try{
      const x=await api('/api/dj-catalog/scans',{method:'POST',body:JSON.stringify({source})});
      djScan=x.scan||null;render();
      const link=document.createElement('a');
      link.href=x.launch_url;link.target='_blank';link.rel='noopener noreferrer';link.style.display='none';
      document.body.appendChild(link);link.click();link.remove();
      alert('Scanner criado para '+Number(x.scan?.total||0)+' faixas. A Twitch abriu em uma nova aba e o Tampermonkey inicia a verificação automaticamente assim que o catálogo carregar. Se a aba não abrir, permita pop-ups para o MediaForge e clique novamente.');
    }catch(e){alert('Falha ao iniciar o scanner: '+e.message)}
    finally{
      const b=document.getElementById(isNew?'startDjCatalogScan':'startDjCatalogLegacy');
      if(b){b.disabled=false;b.textContent=isNew?'2. Verificar 100 novas':'Lista anterior (215)';}
    }
  }

  async function loadSessions(){try{captureDraft();const [x,o,ds]=await Promise.all([api('/api/live-sessions'),api('/api/ovh/status'),api('/api/dj-catalog/scans?limit=1').catch(()=>({scans:[]}))]);sessions=x.sessions||[];ovh=o;djScan=(ds.scans||[])[0]||djScan;render();}catch(e){console.error(e);}}
  async function load(){if(loading)return;loading=true;try{if(!API){render();return;}await api('/api/me');const [cat,lib,ls,o,ds]=await Promise.all([api('/api/catalog'),api('/api/music-library'),api('/api/live-sessions'),api('/api/ovh/status'),api('/api/dj-catalog/scans?limit=1').catch(()=>({scans:[]}))]);catalog=cat;musicLibrary=lib||{playlists:[]};sessions=ls.sessions||[];ovh=o;djScan=(ds.scans||[])[0]||null;render();}catch(e){root().innerHTML=`<div class="card" style="color:#ffb2ba"><b>Falha ao carregar o MediaForge</b><div class="small" style="margin-top:7px">${esc(e.message)}</div><button class="btn" style="margin-top:12px" onclick="location.reload()">↻ Tentar novamente</button></div>`;}finally{loading=false;}}
  document.querySelectorAll('.platform-tabs .tab[data-platform]').forEach(tab=>tab.onclick=e=>{e.preventDefault();captureDraft();activePlatform=tab.dataset.platform||'kick';history.replaceState(null,'',`?platform=${activePlatform}`);render();});
  document.getElementById('refresh')?.addEventListener('click',load);load();setInterval(()=>{if(document.visibilityState==='visible'&&catalog)loadSessions();},15000);
})();
