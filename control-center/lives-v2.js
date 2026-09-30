(()=>{
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const BUCKET='office-music-assets';
  const ANALYTICS='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/live-analytics.json';
  const YT_PLAYLISTS='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/youtube-playlists.json';
  const RAW='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control';
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let platform='youtube';
  let state={tracks:[],jobs:[],lives:[],assets:[],playlists:[],youtubePlaylists:[],youtubePlaylistsUpdatedAt:null,analytics:null,kickResults:{},masterRelease:null};

  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const fmt=d=>d?new Date(d).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const urlOf=t=>String(t?.metadata?.download_url||t?.metadata?.release_download_url||t?.github_path||'');
  const isKick=l=>String(l?.title||'').startsWith('[KICK]')||String(l?.description||'').startsWith('[platform:kick]');
  const cleanTitle=l=>String(l?.title||'Peter Lofi — Live').replace(/^\[KICK\]\s*/,'');
  const active=s=>['queued','starting','live','reconnecting','stopping'].includes(s);
  const playable=()=>state.tracks.filter(t=>urlOf(t));

  async function invoke(body){
    const fn=body.action==='start_live'?'office-music-queue-control':'office-music-control';
    const {data,error}=await client.functions.invoke(fn,{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  }
  async function fetchJson(url){try{const r=await fetch(url+'?v='+Date.now(),{cache:'no-store'});if(!r.ok)return null;return await r.json()}catch{return null}}
  async function fetchAllRows(table,order='created_at'){
    const all=[];let from=0;const size=1000;
    while(true){
      const {data,error}=await client.from(table).select('*').order(order,{ascending:false}).range(from,from+size-1);
      if(error)throw error;
      all.push(...(data||[]));
      if(!data||data.length<size)break;
      from+=size;
    }
    return all;
  }
  async function auth(){const {data:{session}}=await client.auth.getSession();if(!session){location.href='./index.html';return null}document.getElementById('userBox').textContent=session.user?.email||'Administrador';return session}
  function assetPublicUrl(a){if(!a?.storage_path)return '';return client.storage.from(BUCKET).getPublicUrl(a.storage_path).data.publicUrl||''}

  async function load(){
    const [tracks,jobs,lives,assets,playlists,yt,an,health]=await Promise.all([
      fetchAllRows('office_music_tracks'),
      fetchAllRows('office_music_jobs'),
      fetchAllRows('office_music_live_sessions'),
      fetchAllRows('office_music_assets'),
      fetchAllRows('office_music_playlists'),
      fetchJson(YT_PLAYLISTS),
      fetchJson(ANALYTICS),
      invoke({action:'health'}).catch(()=>null)
    ]);
    state.tracks=tracks;state.jobs=jobs;state.lives=lives;state.assets=assets;state.playlists=playlists;state.analytics=an;state.masterRelease=health?.master_release||health?.masterRelease||null;
    state.youtubePlaylists=yt?.playlists||[];state.youtubePlaylistsUpdatedAt=yt?.generated_at||null;
    const ytActive=state.lives.filter(l=>!isKick(l)&&active(l.status)).slice(0,8);
    await Promise.allSettled(ytActive.map(l=>invoke({action:'sync_live',session_id:l.id})));
    if(ytActive.length)state.lives=await fetchAllRows('office_music_live_sessions');
    const kicks=state.lives.filter(isKick).slice(0,30);
    const entries=await Promise.all(kicks.map(async l=>[l.id,await fetchJson(`${RAW}/kick-live-results/${l.id}.json`)]));
    state.kickResults=Object.fromEntries(entries.filter(x=>x[1]));
  }

  function jobVideoId(j){return String(j?.youtube_video_id||j?.metadata?.youtube_video_id||j?.metadata?.video_id||'')}
  function youtubePlaylistTrackIds(pid){
    const p=state.youtubePlaylists.find(x=>String(x.id||x.playlist_id)===String(pid));
    if(!p)return [];
    const vids=(p.videos||p.items||[]).map(v=>String(v.video_id||v.id||v.contentDetails?.videoId||'')).filter(Boolean);
    const jobIds=new Set(state.jobs.filter(j=>vids.includes(jobVideoId(j))).map(j=>String(j.id)));
    return state.tracks.filter(t=>jobIds.has(String(t.job_id))&&urlOf(t)).map(t=>String(t.id));
  }
  function ytPlaylistOptions(){
    if(!state.youtubePlaylists.length)return '<option value="">Nenhuma playlist encontrada no YouTube</option>';
    return state.youtubePlaylists.map(p=>{const id=p.id||p.playlist_id;const videos=(p.videos||p.items||[]).length;const matched=youtubePlaylistTrackIds(id).length;return `<option value="${esc(id)}">${esc(p.title||p.name||'Playlist YouTube')} · ${videos} vídeos · ${matched} faixas disponíveis</option>`}).join('');
  }
  function mfPlaylistOptions(){return state.playlists.map(p=>`<option value="${esc(p.id)}">${esc(p.name||'Playlist')} · ${(p.track_ids||[]).length} faixas</option>`).join('')}
  function thumbOptions(){return state.assets.filter(a=>a.asset_type==='thumbnail').map(a=>`<option value="${esc(a.id)}" ${a.is_default?'selected':''}>${esc(a.title||a.storage_path||'Thumbnail')}</option>`).join('')}
  function visualOptions(){return state.assets.filter(a=>a.asset_type==='loop').map(a=>`<option value="${esc(a.id)}" ${a.is_default?'selected':''}>${esc(a.title||a.storage_path||'Visual')}</option>`).join('')}

  function trackPicker(filter=''){
    const q=String(filter||'').trim().toLowerCase();
    const list=playable().filter(t=>!q||`${t.title||''} ${t.filename||''} ${t.style||''}`.toLowerCase().includes(q));
    if(!list.length)return '<div class="note">Nenhuma faixa encontrada.</div>';
    return list.map(t=>`<label class="track" data-search="${esc(`${t.title||''} ${t.filename||''} ${t.style||''}`.toLowerCase())}"><input class="pick" type="checkbox" value="${esc(t.id)}"><div><b class="small">${esc(t.title||t.filename||'Faixa')}</b><div class="tiny muted">${Math.max(1,Math.round(Number(t.duration_seconds||0)/60))} min · ${esc(t.style||'Peter Lofi')}</div></div><span class="tiny muted">♫</span></label>`).join('');
  }
  function selectedCount(root){return root.querySelectorAll('.pick:checked').length}
  function updateSelected(root){const el=root.querySelector('#selectedCount');if(el)el.textContent=`${selectedCount(root)} selecionadas de ${playable().length} disponíveis`}
  function applyIds(root,ids){const set=new Set((ids||[]).map(String));root.querySelectorAll('.pick').forEach(x=>x.checked=set.has(String(x.value)));updateSelected(root)}

  async function uploadVisual(file,bar){
    if(!window.tus)throw new Error('O módulo de upload ainda não carregou. Atualize a página e tente novamente.');
    const {data:{session}}=await client.auth.getSession();if(!session)throw new Error('Sessão expirada');
    const safe=(file.name||'visual').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').slice(-100);
    const path=`loop/${Date.now()}-${crypto.randomUUID()}-${safe}`;
    return new Promise((resolve,reject)=>{
      const up=new tus.Upload(file,{endpoint:`${SB_URL}/storage/v1/upload/resumable`,retryDelays:[0,1000,3000,5000,10000],headers:{authorization:`Bearer ${session.access_token}`,'x-upsert':'true'},uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,chunkSize:6*1024*1024,metadata:{bucketName:BUCKET,objectName:path,contentType:file.type||'application/octet-stream',cacheControl:'3600'},onError:reject,onProgress:(sent,total)=>{if(bar)bar.style.width=Math.round(sent/total*100)+'%'},onSuccess:async()=>{try{const r=await invoke({action:'register_asset',asset_type:'loop',storage_path:path,title:file.name,mime_type:file.type,size_bytes:file.size,set_default:true});resolve(r)}catch(e){reject(e)}}});
      up.findPreviousUploads().then(prev=>{if(prev.length)up.resumeFromPreviousUpload(prev[0]);up.start()}).catch(()=>up.start());
    });
  }

  function effective(l){if(isKick(l)&&state.kickResults[l.id])return {...l,...state.kickResults[l.id],title:cleanTitle(l)};return l}
  function ytMetric(l){const sessions=state.analytics?.youtube?.sessions||[];return sessions.find(x=>String(x.session_id)===String(l.id))?.data||null}
  function kickChannel(){return state.analytics?.kick?.channel||null}
  function num(v){if(v==null||v==='')return '—';const n=Number(v);return Number.isFinite(n)?n.toLocaleString('pt-BR'):String(v)}
  function liveMetrics(l){if(isKick(l)){const c=kickChannel(),s=c?.stream||{};return [{k:'ONLINE',v:num(s.viewer_count??c?.viewer_count)},{k:'SEGUIDORES',v:num(c?.followers_count??c?.followers)},{k:'INSCRITOS',v:num(c?.active_subscribers_count)},{k:'CATEGORIA',v:c?.category?.name||'—'}]}const d=ytMetric(l),st=d?.statistics||{},ls=d?.liveStreamingDetails||{};return [{k:'ONLINE',v:num(ls.concurrentViewers)},{k:'VISUALIZAÇÕES',v:num(st.viewCount)},{k:'LIKES',v:num(st.likeCount)},{k:'COMENTÁRIOS',v:num(st.commentCount)}]}
  function livesFor(p){return state.lives.filter(l=>p==='kick'?isKick(l):!isKick(l)).map(effective)}
  function liveCards(p){const list=livesFor(p);if(!list.length)return '<div class="note">Nenhuma live registrada nesta plataforma ainda.</div>';return list.map(l=>{const st=l.status||'queued',metrics=liveMetrics(l);return `<article class="card livecard" data-id="${esc(l.id)}"><div class="row between wrap"><div><b class="small">${esc(cleanTitle(l))}</b><div class="tiny muted">${fmt(l.created_at||l.started_at)} · ${l.duration_minutes==null?'contínua':esc(l.duration_minutes)+' min'}</div></div><span class="pill ${esc(st)}">${esc(st==='live'?'AO VIVO':st)}</span></div><div class="metrics">${metrics.map(m=>`<div class="metric"><small>${esc(m.k)}</small><b>${esc(m.v)}</b></div>`).join('')}</div>${active(st)?`<div class="row" style="margin-top:10px"><button class="btn danger stop" data-id="${esc(l.id)}">Encerrar</button></div>`:''}</article>`}).join('')}
  function analyticsNote(p){if(p==='kick')return state.analytics?.kick?.configured?'Snapshot da API Kick ativo. Viewers, seguidores, inscritos, categoria e demais campos disponíveis são atualizados pelo coletor.':'Motor da Kick pronto. Para analytics e automação completa, conecte as credenciais da Kick.';return state.analytics?.youtube?.configured?'YouTube Data API conectada. O painel coleta viewers simultâneos, visualizações, likes e comentários.':'O painel está pronto, mas o coletor ainda não recebeu um snapshot atualizado do YouTube.'}

  function form(p){
    const kick=p==='kick';
    const desc=kick?'Peter Lofi live radio — original lofi beats for work, focus and late-night sessions.':'Stylish original Peter Lofi beats for work, focus, study and late-night sessions.\n\n🎧 Subscribe to Peter Lofi:\nhttps://www.youtube.com/@PeterLofiSounds\n\n#PeterLofi #Lofi #LofiMusic #FocusMusic';
    const ytUpdated=state.youtubePlaylistsUpdatedAt?`Atualizado ${fmt(state.youtubePlaylistsUpdatedAt)}`:'Snapshot ainda não sincronizado';
    return `<div class="grid grid2"><section class="card"><div class="row"><span class="dot ${kick?'kick':''}"></span><b>${kick?'Kick Live':'YouTube Live'}</b></div>
      <div class="field"><label>TÍTULO</label><input id="title" class="input" maxlength="120" value="Peter Lofi — ${kick?'Kick Live':'Live Lofi Radio'} 🎧"></div>
      <div class="field"><label>DESCRIÇÃO / NOTAS</label><textarea id="description" class="input" rows="5">${esc(desc)}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div class="field"><label>DURAÇÃO</label><select id="duration" class="select"><option value="60">1 hora</option><option value="120">2 horas</option><option value="180">3 horas</option><option value="360">6 horas</option><option value="720">12 horas</option><option value="0">Contínua</option></select></div><div class="field"><label>THUMBNAIL</label><select id="thumb" class="select"><option value="">Padrão</option>${thumbOptions()}</select></div></div>
      <div class="field"><label>VISUAL DA LIVE</label><select id="visual" class="select"><option value="">Master visual padrão</option>${visualOptions()}</select><div class="tiny muted" style="margin-top:5px">Imagem fica fixa durante a transmissão; vídeo é repetido em loop.</div></div>
      <div class="field"><label>SUBIR UMA IMAGEM OU VÍDEO PARA ESTA LIVE</label><label class="assetdrop" for="visualFile"><b>＋ Selecionar JPG, PNG, WEBP, MP4 ou MOV</b><small>O arquivo será salvo nos Assets e usado nesta transmissão.</small></label><input id="visualFile" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" style="display:none"><div class="uploadbar"><span id="visualProgress"></span></div><div id="visualFileName" class="tiny muted" style="margin-top:5px"></div></div>
      <div class="field"><label>PLAYLIST DO YOUTUBE</label><select id="ytPlaylist" class="select"><option value="">Não usar playlist do YouTube</option>${ytPlaylistOptions()}</select><div class="tiny muted" style="margin-top:5px">${esc(ytUpdated)}. Ao selecionar, marcamos as faixas-fonte que existem na biblioteca MediaForge.</div></div>
      <div class="field"><label>PLAYLIST SALVA NO MEDIAFORGE</label><select id="playlist" class="select"><option value="">Seleção manual</option>${mfPlaylistOptions()}</select></div>
      <div class="field"><label>BUSCAR MÚSICA</label><input id="trackSearch" class="input" placeholder="Buscar por nome ou estilo..."></div>
      <div class="row between wrap"><div class="small"><b>Músicas da live</b><div id="selectedCount" class="tiny muted">0 selecionadas de ${playable().length} disponíveis</div></div><div class="row"><button id="all" class="btn" type="button">Selecionar tudo</button><button id="none" class="btn" type="button">Limpar</button></div></div>
      <div id="trackList" class="tracklist">${trackPicker()}</div>
      ${kick?'<div class="note" style="margin-top:12px"><b>Kick:</b> o encoder usa RTMPS, H.264 1080p/30 e AAC. Quando Stream Key/ingest estiverem conectados, o mesmo visual e a mesma seleção musical serão transmitidos na Kick.</div>':''}
      <button id="start" class="btn ${kick?'kick':'primary'} block" style="margin-top:14px" ${playable().length?'':'disabled'}>${kick?'● Iniciar na Kick':'▶ Iniciar no YouTube'}</button>
    </section><section class="grid"><div class="card"><div class="row between"><b>Lives ${kick?'na Kick':'no YouTube'}</b><span class="tiny muted">clique em uma live para detalhes</span></div><div class="grid" style="margin-top:12px">${liveCards(p)}</div></div><div class="card"><b>Analytics</b><div class="note" style="margin-top:10px">${analyticsNote(p)}</div></div></section></div>`;
  }

  function render(){
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.platform===platform));
    const content=document.getElementById('content');content.innerHTML=form(platform);const root=content;
    root.querySelector('#all').onclick=()=>{root.querySelectorAll('.pick').forEach(x=>x.checked=true);updateSelected(root)};
    root.querySelector('#none').onclick=()=>applyIds(root,[]);
    root.querySelectorAll('.pick').forEach(x=>x.onchange=()=>updateSelected(root));
    root.querySelector('#playlist').onchange=e=>{const p=state.playlists.find(x=>String(x.id)===String(e.target.value));applyIds(root,p?.track_ids||[]);if(e.target.value)root.querySelector('#ytPlaylist').value=''};
    root.querySelector('#ytPlaylist').onchange=e=>{const ids=youtubePlaylistTrackIds(e.target.value);applyIds(root,ids);if(e.target.value)root.querySelector('#playlist').value='';if(e.target.value&&!ids.length)alert('A playlist apareceu, mas nenhum vídeo dela possui faixas-fonte correspondentes na biblioteca MediaForge. Você ainda pode selecionar músicas manualmente.')};
    root.querySelector('#trackSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();root.querySelectorAll('.track').forEach(el=>el.style.display=!q||String(el.dataset.search||'').includes(q)?'grid':'none')};
    const vf=root.querySelector('#visualFile');vf.onchange=()=>{root.querySelector('#visualFileName').textContent=vf.files?.[0]?`${vf.files[0].name} · ${(vf.files[0].size/1024/1024).toFixed(1)} MB`:''};
    root.querySelector('#start').onclick=start;
    root.querySelectorAll('.stop').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(!confirm('Encerrar esta live agora?'))return;b.disabled=true;try{await invoke({action:'stop_live',session_id:b.dataset.id});alert('Encerramento solicitado.');setTimeout(refresh,1500)}catch(err){alert('Falha: '+(err.message||err));b.disabled=false}});
    root.querySelectorAll('.livecard').forEach(c=>c.onclick=()=>showDetail(c.dataset.id));
  }

  async function start(){
    const root=document.getElementById('content'),btn=root.querySelector('#start');
    const ids=[...root.querySelectorAll('.pick:checked')].map(x=>x.value);if(!ids.length){alert('Selecione pelo menos uma música.');return}
    const d=Number(root.querySelector('#duration').value);let title=root.querySelector('#title').value.trim()||'Peter Lofi — Live',description=root.querySelector('#description').value;
    if(platform==='kick'){title='[KICK] '+title;description='[platform:kick]\n'+description}
    btn.disabled=true;btn.textContent='Preparando…';
    try{
      let visualId=root.querySelector('#visual').value||null,loopUrl='';
      const file=root.querySelector('#visualFile').files?.[0];
      if(file){btn.textContent='Enviando visual…';await uploadVisual(file,root.querySelector('#visualProgress'));state.assets=await fetchAllRows('office_music_assets');const uploaded=state.assets.find(a=>a.asset_type==='loop'&&a.title===file.name&&a.is_default)||state.assets.find(a=>a.asset_type==='loop'&&a.title===file.name)||state.assets.find(a=>a.asset_type==='loop'&&a.is_default);visualId=uploaded?.id||null;loopUrl=uploaded?assetPublicUrl(uploaded):''}
      else if(visualId){const chosen=state.assets.find(a=>String(a.id)===String(visualId));loopUrl=chosen?assetPublicUrl(chosen):'';await invoke({action:'set_default_asset',asset_id:visualId}).catch(()=>{})}
      else loopUrl=String(state.masterRelease?.loop_url||state.masterRelease?.download_url||'');
      btn.textContent='Abrindo live…';
      await invoke({action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title,description,thumbnail_asset_id:root.querySelector('#thumb').value||null,visual_asset_id:visualId,loop_asset_id:visualId,loop_url:loopUrl||null});
      alert(platform==='kick'?'Live da Kick enviada para a fila.':'Live do YouTube enviada para a fila.');await refresh();
    }catch(e){alert('Falha ao iniciar: '+(e.message||e));btn.disabled=false;btn.textContent=platform==='kick'?'● Iniciar na Kick':'▶ Iniciar no YouTube'}
  }

  function showDetail(id){const original=state.lives.find(l=>String(l.id)===String(id));if(!original)return;const l=effective(original),kick=isKick(original),metrics=liveMetrics(original),yt=kick?null:ytMetric(original),kc=kickChannel();const root=document.getElementById('modalRoot');root.innerHTML=`<div class="modal"><div class="modalbox"><button class="btn close">✕ Fechar</button><div class="row"><span class="dot ${kick?'kick':''}"></span><b>${kick?'Kick':'YouTube'} · ${esc(cleanTitle(original))}</b></div><div class="tiny muted" style="margin-top:5px">Sessão ${esc(id)} · status ${esc(l.status||original.status||'—')}</div><div class="metrics">${metrics.map(m=>`<div class="metric"><small>${esc(m.k)}</small><b>${esc(m.v)}</b></div>`).join('')}</div><div class="card" style="margin-top:12px"><b class="small">Informações da transmissão</b><div class="tiny muted" style="line-height:1.8;margin-top:8px">Início: ${esc(fmt(l.live_at||l.started_at||original.created_at))}<br>Duração: ${original.duration_minutes==null?'contínua':esc(original.duration_minutes)+' min'}<br>${kick?`Canal Kick: ${esc(state.analytics?.kick?.channel_slug||'a conectar')}<br>Título API: ${esc(kc?.stream_title||kc?.stream?.title||'—')}`:`URL: ${yt?.id?`https://youtube.com/watch?v=${esc(yt.id)}`:esc(l.youtube_url||'—')}`}</div></div></div></div>`;root.querySelector('.close').onclick=()=>root.innerHTML='';root.querySelector('.modal').onclick=e=>{if(e.target===root.querySelector('.modal'))root.innerHTML=''}}
  async function refresh(){try{await load();render()}catch(e){document.getElementById('content').innerHTML='<div class="card" style="color:#ffb2ba">Erro ao carregar a central de lives: '+esc(e.message||e)+'</div>'}}
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{platform=b.dataset.platform;render()});
  document.getElementById('refresh').onclick=refresh;
  (async()=>{if(await auth())await refresh()})();
})();