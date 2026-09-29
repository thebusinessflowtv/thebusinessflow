(()=>{
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const BUCKET='office-music-assets';
  const YT_PLAYLIST_SNAPSHOT='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/youtube-playlists.json';
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const terminal=new Set(['completed','failed']);
  let state={jobs:[],tracks:[],lives:[],assets:[],youtubePlaylists:[],youtubePlaylistsUpdatedAt:null,masterRelease:null,tab:'generate'};
  let refreshTimer=null;

  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const fmt=d=>d?new Date(d).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const mm=s=>Math.max(1,Math.round(Number(s||0)/60));
  const urlOf=t=>String(t?.metadata?.download_url||t?.github_path||'');
  const liveActive=s=>['queued','starting','live','reconnecting','stopping'].includes(s);
  const jobTone=s=>s==='completed'?'green':s==='failed'?'red':s==='queued'?'amber':'blue';
  const jobLabel=s=>({queued:'Na fila',generating:'Gerando músicas',rendering:'Renderizando 4K',uploading:'Enviando ao YouTube',completed:'Concluído',failed:'Falhou'}[s]||s||'—');
  const liveTone=s=>s==='live'?'green':s==='completed'?'blue':s==='failed'?'red':'amber';
  const liveLabel=s=>({queued:'Preparando',starting:'Conectando ao YouTube',live:'AO VIVO',reconnecting:'Reconectando',stopping:'Encerrando',completed:'Encerrada',failed:'Falhou'}[s]||s||'—');

  function toast(title,text='',type='ok'){
    const root=document.getElementById('toasts'); if(!root)return;
    const el=document.createElement('div'); el.className='toast'+(type==='error'?' error':'');
    el.innerHTML='<b>'+esc(title)+'</b><div class="muted">'+esc(text)+'</div>'; root.appendChild(el); setTimeout(()=>el.remove(),5000);
  }

  async function invoke(body){
    const queueAction=body?.action==='create_job'||body?.action==='start_live'||body?.action==='stop_live';
    const syncAction=body?.action==='sync_job'||body?.action==='sync_live';
    const functionName=queueAction?'office-music-queue-control':(syncAction?'office-music-sync-control':'office-music-control');
    const {data,error}=await client.functions.invoke(functionName,{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  }

  async function loadYoutubePlaylistSnapshot(){
    try{
      const r=await fetch(YT_PLAYLIST_SNAPSHOT+'?v='+Date.now(),{cache:'no-store'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const data=await r.json();
      return {playlists:Array.isArray(data?.playlists)?data.playlists:[],generated_at:data?.generated_at||null};
    }catch(_){return {playlists:[],generated_at:null}}
  }

  async function auth(){
    const {data:{session}}=await client.auth.getSession();
    if(!session){ location.href='./index.html'; return null; }
    const email=session.user?.email||'Administrador';
    const box=document.getElementById('userBox'); if(box)box.textContent=email;
    return session;
  }

  async function loadData(sync=true){
    const masterReleaseP=invoke({action:'health'}).catch(()=>null);
    const youtubePlaylistsP=loadYoutubePlaylistSnapshot();
    const [jobsR,tracksR,livesR,assetsR]=await Promise.all([
      client.from('office_music_jobs').select('*').order('created_at',{ascending:false}).limit(30),
      client.from('office_music_tracks').select('*').order('created_at',{ascending:false}).limit(200),
      client.from('office_music_live_sessions').select('*').order('created_at',{ascending:false}).limit(30),
      client.from('office_music_assets').select('*').order('created_at',{ascending:false}).limit(100)
    ]);
    for(const r of [jobsR,tracksR,livesR,assetsR]) if(r.error)throw r.error;
    state.jobs=jobsR.data||[]; state.tracks=tracksR.data||[]; state.lives=livesR.data||[]; state.assets=assetsR.data||[]; state.masterRelease=await masterReleaseP; const yp=await youtubePlaylistsP; state.youtubePlaylists=yp.playlists||[]; state.youtubePlaylistsUpdatedAt=yp.generated_at||null;
    if(sync){
      const jobs=state.jobs.filter(j=>!terminal.has(j.status)).slice(0,5);
      const lives=state.lives.filter(l=>liveActive(l.status)).slice(0,4);
      await Promise.allSettled([
        ...jobs.map(j=>invoke({action:'sync_job',job_id:j.id})),
        ...lives.map(l=>invoke({action:'sync_live',session_id:l.id}))
      ]);
      if(jobs.length||lives.length)return loadData(false);
    }
    return state;
  }

  function tab(name){
    state.tab=name;
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));
    ['generate','live','library','assets'].forEach(v=>document.getElementById('view-'+v)?.classList.toggle('hidden',v!==name));
    if(name==='generate')renderGenerate();
    if(name==='live')renderLive();
    if(name==='library')renderLibrary();
    if(name==='assets')renderAssets();
  }

  function jobsHtml(){
    if(!state.jobs.length)return '<div class="empty">Nenhuma geração criada ainda.</div>';
    return state.jobs.slice(0,10).map(j=>{
      const links=[]; if(j.youtube_url)links.push('<a class="btn" target="_blank" rel="noopener" href="'+esc(j.youtube_url)+'">▶ YouTube</a>'); if(j.github_run_url)links.push('<a class="btn" target="_blank" rel="noopener" href="'+esc(j.github_run_url)+'">⌘ Execução</a>');
      return `<div class="job"><div class="row between wrap"><div><b class="small">${esc(j.title||('Mix de '+j.requested_duration_minutes+' minutos'))}</b><div class="tiny muted" style="margin-top:3px">${fmt(j.created_at)} · ${j.requested_duration_minutes} min · ${j.requested_tracks} faixas</div></div><span class="pill ${jobTone(j.status)}">${esc(jobLabel(j.status))}</span></div><div class="progress"><span style="width:${Math.max(0,Math.min(100,Number(j.progress)||0))}%"></span></div>${j.error_message?'<div class="note" style="border-color:#66353b;background:#2b181b;color:#ffadb5;margin-top:9px">'+esc(j.error_message)+'</div>':''}${links.length?'<div class="row wrap" style="margin-top:9px">'+links.join('')+'</div>':''}</div>`;
    }).join('');
  }

  function renderGenerate(){
    const root=document.getElementById('view-generate'); if(!root)return;
    const thumb=state.assets.find(a=>a.asset_type==='thumbnail'&&a.is_default);
    const images=state.assets.filter(a=>a.asset_type==='thumbnail');
    const defaultImage=thumb||images[0]||null;
    root.innerHTML=`<div class="grid grid2">
      <div class="grid">
        <div class="card hero">
          <div class="label">Music Generator</div>
          <h2 style="margin-top:8px">Gerar sessão completa</h2>
          <p class="small muted" style="line-height:1.6;margin:6px 0 18px">Escolha a duração e o visual. Cada solicitação gera um conjunto novo de músicas; áudio de jobs anteriores nunca é usado para completar a duração.</p>
          <div class="field"><label>Duração total</label><div class="row"><input id="duration" class="input duration" type="number" min="6" max="360" step="1" value="60" style="max-width:170px"><b class="muted">min</b></div><div class="chips">${[30,60,90,120,180].map(x=>`<button class="chip ${x===60?'on':''}" data-min="${x}">${x} min</button>`).join('')}</div></div>
          <div class="field"><label>Visual do vídeo</label><select id="visualMode" class="select"><option value="video">Vídeo em loop — master do GitHub</option><option value="image">Imagem fixa — durante o vídeo inteiro</option></select><div class="tiny muted" style="margin-top:6px">No modo vídeo, usamos o master oficial salvo no GitHub. No modo imagem, a imagem selecionada permanece 100% fixa do início ao fim.</div></div>
          <div class="field hidden" id="fixedImageField"><label>Imagem fixa</label><select id="fixedImage" class="select" ${images.length?'':'disabled'}>${images.length?images.map(a=>`<option value="${esc(a.id)}" ${defaultImage&&a.id===defaultImage.id?'selected':''}>${esc(a.title||'Imagem')}</option>`).join(''):'<option value="">Nenhuma imagem cadastrada em Assets</option>'}</select><div class="tiny muted" style="margin-top:6px">Você pode enviar novas imagens na aba Assets e depois selecioná-las aqui.</div></div>
          <div class="grid" style="grid-template-columns:repeat(3,1fr);margin:18px 0"><div class="metric"><small>MÚSICA</small><b>100% nova por job</b></div><div class="metric"><small>VÍDEO</small><b>4K · 3840×2160</b></div><div class="metric"><small>YOUTUBE</small><b>Público automático</b></div></div>
          <div class="note"><b>Proteção contra repetição ativada.</b> Cada job recebe uma seed própria vinculada ao novo ID. Se não houver músicas novas e únicas suficientes para preencher a duração, a produção falha em vez de repetir uma faixa ou reutilizar áudio antigo.<br><br>Vídeo padrão: <b>GitHub Release office-assets-v1 · office-music-master-loop.mp4</b>${thumb?'<br>Thumbnail padrão: <b>'+esc(thumb.title||'Thumbnail')+'</b>':''}</div>
          <button id="generateBtn" class="btn primary block" style="margin-top:16px;min-height:45px">♫ Gerar músicas novas + vídeo 4K + publicar</button>
        </div>
        <div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Gerações</h3><button id="refreshJobs" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">${jobsHtml()}</div></div>
      </div>
      <div class="grid">
        <div class="card pad"><div class="label">Fluxo automático</div><div class="list" style="margin-top:12px"><div class="metric"><small>01</small><b>Geração musical inédita</b><div class="tiny muted">Medium → Small fallback. Se ambos falharem, o job para; não existe fallback para música antiga.</div></div><div class="metric"><small>02</small><b>Validação anti-repetição</b><div class="tiny muted">Hash das faixas + ID da solicitação + duração única suficiente. Nenhuma faixa é ciclada para completar o mix.</div></div><div class="metric"><small>03</small><b>Visual selecionável</b><div class="tiny muted">Master em vídeo do GitHub ou imagem totalmente fixa.</div></div><div class="metric"><small>04</small><b>Publicação</b><div class="tiny muted">Render 4K + upload resumível + título + descrição + capítulos</div></div></div></div>
        <div class="card pad"><h3 class="section-title">DNA musical fixo</h3><div class="small muted" style="line-height:1.7">120–123 BPM · fashion-retail deep/lounge house · kick 4/4 limpo · baixo arredondado · hats nítidos · synth plucks minimalistas · pads quentes · energia 6/10 · instrumental · sem drops agressivos · mix comercial premium para escritório/home office.</div></div>
      </div>
    </div>`;
    root.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{root.querySelector('#duration').value=b.dataset.min;root.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===b))});
    const mode=root.querySelector('#visualMode');
    const fixed=root.querySelector('#fixedImageField');
    const updateVisual=()=>fixed.classList.toggle('hidden',mode.value!=='image');
    mode.onchange=updateVisual; updateVisual();
    root.querySelector('#refreshJobs').onclick=refresh;
    root.querySelector('#generateBtn').onclick=async()=>{
      const btn=root.querySelector('#generateBtn');
      const duration=Math.max(6,Math.min(360,Number(root.querySelector('#duration').value||60)));
      const visualMode=mode.value==='image'?'image':'video';
      const visualAssetId=visualMode==='image'?(root.querySelector('#fixedImage')?.value||''):'';
      if(visualMode==='image'&&!visualAssetId){toast('Selecione uma imagem','Cadastre ou selecione uma imagem na aba Assets antes de gerar.','error');return}
      btn.disabled=true; btn.textContent='Criando produção…';
      try{
        await invoke({action:'create_job',duration_minutes:duration,publish:true,privacy:'public',visual_mode:visualMode,visual_asset_id:visualAssetId||null});
        toast('Produção iniciada',`${duration} minutos · ${visualMode==='image'?'imagem fixa':'vídeo do GitHub'} · músicas novas · publicação pública`);
        await refresh();
      }
      catch(e){toast('Falha ao iniciar',e.message||String(e),'error');btn.disabled=false;btn.textContent='♫ Gerar músicas novas + vídeo 4K + publicar'}
    };
  }

  function youtubePlaylistTrackIds(playlistId){
    const p=state.youtubePlaylists.find(x=>x.id===playlistId); if(!p)return [];
    const jobsByVideo=new Map(state.jobs.filter(j=>j.youtube_video_id).map(j=>[String(j.youtube_video_id),j]));
    const out=[],seen=new Set();
    for(const item of (p.items||[])){
      const job=jobsByVideo.get(String(item.video_id||'')); if(!job)continue;
      const tracks=state.tracks.filter(t=>t.job_id===job.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
      for(const t of tracks)if(!seen.has(t.id)&&urlOf(t)){seen.add(t.id);out.push(t.id)}
    }
    return out;
  }

  function youtubePlaylistStats(p){
    const jobsByVideo=new Map(state.jobs.filter(j=>j.youtube_video_id).map(j=>[String(j.youtube_video_id),j]));
    let matchedVideos=0,trackCount=0;
    for(const item of (p.items||[])){
      const job=jobsByVideo.get(String(item.video_id||'')); if(!job)continue;
      matchedVideos++;
      trackCount+=state.tracks.filter(t=>t.job_id===job.id&&urlOf(t)).length;
    }
    return {matchedVideos,trackCount};
  }

  function tracksPicker(){
    if(!state.tracks.length)return '<div class="empty">Gere pelo menos uma sessão para liberar faixas para live.</div>';
    return state.tracks.slice(0,80).map((t,i)=>{const u=urlOf(t);return `<label class="track" style="cursor:pointer"><input class="liveTrack" type="checkbox" value="${esc(t.id)}" ${i<10?'checked':''}><div><b>${esc(t.title)}</b><small>${mm(t.duration_seconds)} min${t.bpm?' · '+esc(t.bpm)+' BPM':''}</small></div>${u?`<audio controls preload="none" src="${esc(u)}"></audio>`:'<span class="tiny muted">sem preview</span>'}</label>`}).join('');
  }

  function liveSessionsHtml(){
    if(!state.lives.length)return '<div class="empty">Nenhuma live criada ainda.</div>';
    return state.lives.slice(0,10).map(l=>`<div class="liveitem"><div class="row between wrap"><div><b class="small">${esc(l.title||'The Office Music Live')}</b><div class="tiny muted" style="margin-top:3px">${fmt(l.created_at)} · ${l.duration_minutes?l.duration_minutes+' min':'contínua'}</div></div><span class="pill ${liveTone(l.status)}">${esc(liveLabel(l.status))}</span></div>${l.error_message?'<div class="note" style="border-color:#66353b;background:#2b181b;color:#ffadb5;margin-top:8px">'+esc(l.error_message)+'</div>':''}<div class="row wrap" style="margin-top:9px">${l.youtube_url?`<a class="btn" target="_blank" rel="noopener" href="${esc(l.youtube_url)}">▶ Abrir live</a>`:''}${l.github_run_url?`<a class="btn" target="_blank" rel="noopener" href="${esc(l.github_run_url)}">⌘ Execução</a>`:''}${liveActive(l.status)?`<button class="btn danger stopLive" data-id="${esc(l.id)}">■ Encerrar</button>`:''}</div></div>`).join('');
  }

  function renderLive(){
    const root=document.getElementById('view-live'); if(!root)return;
    const thumbs=state.assets.filter(a=>a.asset_type==='thumbnail');
    const ytOptions=state.youtubePlaylists.map(p=>{const st=youtubePlaylistStats(p);return `<option value="${esc(p.id)}">${esc(p.title||'Playlist sem nome')} · ${Number(p.item_count||0)} vídeos · ${st.trackCount} faixas reproduzíveis</option>`}).join('');
    const ytUpdated=state.youtubePlaylistsUpdatedAt?fmt(state.youtubePlaylistsUpdatedAt):'ainda não sincronizado';
    root.innerHTML=`<div class="grid grid2">
      <div class="grid">
        <div class="card pad livehero"><div class="row"><span class="live-dot"></span><div class="label">YouTube Live</div></div><h2 style="font-size:18px;margin:11px 0 5px">Abrir uma live do The Office Music</h2><p class="small muted" style="line-height:1.6;margin:0 0 16px">Escolha uma playlist do próprio canal no YouTube ou monte uma seleção manual de músicas salvas. Defina duração e thumbnail; a transmissão começa automaticamente.</p>
          <div class="field"><label>Título da live</label><input id="liveTitle" class="input" maxlength="100" value="The Office Music — Live Office Lounge"></div>
          <div class="field"><label>Descrição da live</label><textarea id="liveDescription" class="input" maxlength="5000" rows="5" style="min-height:110px;resize:vertical;font:inherit" placeholder="Descreva a live, o estilo musical, o canal e inclua links ou chamadas relevantes."></textarea><div class="tiny muted" style="margin-top:5px">Enviada diretamente para a descrição da transmissão no YouTube.</div></div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div class="field"><label>Duração</label><select id="liveDuration" class="select"><option value="60">1 hora</option><option value="120">2 horas</option><option value="180">3 horas</option><option value="360">6 horas</option><option value="720">12 horas</option><option value="0">Contínua — até encerrar manualmente</option></select></div><div class="field"><label>Thumbnail</label><select id="liveThumb" class="select"><option value="">Thumbnail padrão</option>${thumbs.map(a=>`<option value="${esc(a.id)}" ${a.is_default?'selected':''}>${esc(a.title||'Thumbnail')}</option>`).join('')}</select></div></div>
          <div class="field"><div class="row between wrap"><label style="margin:0">Playlist do YouTube</label><button id="reloadYoutubePlaylists" class="btn" type="button">↻ Recarregar</button></div><select id="youtubePlaylist" class="select" style="margin-top:7px"><option value="">Seleção manual / playlist salva do MediaForge</option>${ytOptions}</select><div id="youtubePlaylistInfo" class="tiny muted" style="margin-top:6px">Sincronização automática com o canal a cada hora · último snapshot: ${esc(ytUpdated)}.</div></div>
          <div class="note" style="margin-bottom:12px">Ao escolher uma playlist do YouTube, a ordem dos vídeos da playlist vira a ordem das músicas da live. São reproduzidas as faixas-fonte salvas no MediaForge dos vídeos daquele playlist. Vídeos externos ou antigos sem arquivos-fonte salvos são ignorados.</div>
          <div class="row between" style="margin:8px 0"><div><b class="small">Seleção manual</b><div class="tiny muted">Usada quando nenhuma playlist do YouTube estiver selecionada.</div></div><div class="row"><button id="selectAll" class="btn">Selecionar tudo</button><button id="clearAll" class="btn">Limpar</button></div></div>
          <div class="list" style="max-height:420px;overflow:auto">${tracksPicker()}</div>
          <div class="note" style="margin-top:12px">Modo contínuo é encadeado automaticamente para contornar o limite dos runners hospedados. Pode haver uma reconexão curta a cada bloco longo; o botão Encerrar envia um sinal de parada e finaliza a transmissão no YouTube.</div>
          <button id="startLive" class="btn primary block" style="margin-top:14px;min-height:45px" ${state.tracks.length?'':'disabled'}>● Iniciar live</button>
        </div>
      </div>
      <div class="grid"><div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Lives</h3><button id="refreshLives" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">${liveSessionsHtml()}</div></div><div class="card pad"><h3 class="section-title">Configuração automática</h3><div class="small muted" style="line-height:1.7">RTMP criado pela YouTube Live Streaming API · playlist em loop · vídeo 1080p/30 para estabilidade · áudio AAC · início e encerramento automáticos · reconexão encadeada no modo contínuo.</div></div></div>
    </div>`;
    root.querySelector('#selectAll').onclick=()=>root.querySelectorAll('.liveTrack').forEach(x=>x.checked=true);
    root.querySelector('#clearAll').onclick=()=>root.querySelectorAll('.liveTrack').forEach(x=>x.checked=false);
    root.querySelector('#refreshLives').onclick=refresh;
    const ytSel=root.querySelector('#youtubePlaylist');
    const ytInfo=root.querySelector('#youtubePlaylistInfo');
    const updateYtInfo=()=>{
      if(!ytSel.value){ytInfo.textContent=`Seleção manual ativa · playlists do YouTube sincronizadas: ${state.youtubePlaylists.length} · snapshot: ${ytUpdated}.`;return}
      const p=state.youtubePlaylists.find(x=>x.id===ytSel.value),st=p?youtubePlaylistStats(p):{matchedVideos:0,trackCount:0};
      ytInfo.textContent=p?`${p.title}: ${st.matchedVideos}/${Number(p.item_count||0)} vídeos com fonte disponível · ${st.trackCount} faixas entrarão na live.`:'Playlist indisponível.';
    };
    ytSel.onchange=updateYtInfo; updateYtInfo();
    root.querySelector('#reloadYoutubePlaylists').onclick=async()=>{const b=root.querySelector('#reloadYoutubePlaylists');b.disabled=true;b.textContent='Recarregando…';const yp=await loadYoutubePlaylistSnapshot();state.youtubePlaylists=yp.playlists||[];state.youtubePlaylistsUpdatedAt=yp.generated_at||null;renderLive();toast('Playlists recarregadas',`${state.youtubePlaylists.length} playlists encontradas no snapshot do canal.`)};
    root.querySelectorAll('.stopLive').forEach(b=>b.onclick=async()=>{if(!confirm('Encerrar esta live agora?'))return;b.disabled=true;try{await invoke({action:'stop_live',session_id:b.dataset.id});toast('Encerramento solicitado','A transmissão será finalizada automaticamente.');await refresh()}catch(e){toast('Falha ao encerrar',e.message||String(e),'error');b.disabled=false}});
    root.querySelector('#startLive').onclick=async()=>{
      const playlistId=ytSel.value;
      const ids=playlistId?youtubePlaylistTrackIds(playlistId):[...root.querySelectorAll('.liveTrack:checked')].map(x=>x.value);
      if(!ids.length){toast(playlistId?'Playlist sem fontes reproduzíveis':'Selecione músicas',playlistId?'Nenhum vídeo dessa playlist possui faixas-fonte salvas no MediaForge.':'Escolha pelo menos uma faixa para a live.','error');return}
      const btn=root.querySelector('#startLive');btn.disabled=true;btn.textContent='Preparando transmissão…';
      try{const d=Number(root.querySelector('#liveDuration').value);await invoke({action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title:root.querySelector('#liveTitle').value,description:root.querySelector('#liveDescription').value,thumbnail_asset_id:root.querySelector('#liveThumb').value||null});toast('Live criada',playlistId?`${ids.length} faixas carregadas da playlist do YouTube.`:'A seleção manual foi enviada para a transmissão.');await refresh()}
      catch(e){toast('Falha ao iniciar live',e.message||String(e),'error');btn.disabled=false;btn.textContent='● Iniciar live'}
    };
  }

  function renderLibrary(){
    const root=document.getElementById('view-library'); if(!root)return;
    root.innerHTML=`<div class="card pad"><div class="row between"><div><h3 class="section-title" style="margin:0">Biblioteca de músicas</h3><div class="tiny muted" style="margin-top:4px">Faixas originais salvas pelo pipeline e disponíveis para vídeos e lives.</div></div><span class="pill blue">${state.tracks.length} faixas</span></div><div class="list" style="margin-top:14px">${state.tracks.length?state.tracks.map(t=>{const u=urlOf(t);return `<div class="track"><span class="pill blue">♫</span><div><b>${esc(t.title)}</b><small>${mm(t.duration_seconds)} min${t.bpm?' · '+esc(t.bpm)+' BPM':''} · ${esc(t.style||'fashion-retail lounge house')}</small></div>${u?`<div class="row"><audio controls preload="none" src="${esc(u)}"></audio><a class="btn" target="_blank" rel="noopener" href="${esc(u)}">↓</a></div>`:'<span class="tiny muted">arquivo pendente</span>'}</div>`}).join(''):'<div class="empty">A biblioteca será preenchida após a primeira geração.</div>'}</div></div>`;
  }

  function assetPublicUrl(a){
    try{return client.storage.from(BUCKET).getPublicUrl(a.storage_path).data?.publicUrl||''}catch(_){return ''}
  }

  function openAssetPreview(a){
    const url=assetPublicUrl(a); if(!url){toast('Preview indisponível','Não foi possível obter a URL pública deste asset.','error');return}
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:24px';
    const box=document.createElement('div'); box.style.cssText='width:min(1000px,96vw);max-height:92vh;background:#151517;border:1px solid #3b3b40;border-radius:16px;padding:14px;box-shadow:0 30px 100px #000';
    const head=document.createElement('div'); head.className='row between'; head.innerHTML=`<div><b class="small">${esc(a.title||a.storage_path)}</b><div class="tiny muted">${esc(a.mime_type||'')}</div></div><button class="btn" type="button">✕ Fechar</button>`;
    const media=(a.asset_type==='loop'||String(a.mime_type||'').startsWith('video/'))?document.createElement('video'):document.createElement('img');
    media.src=url; media.style.cssText='display:block;width:100%;max-height:78vh;object-fit:contain;margin-top:12px;border-radius:10px;background:#050506';
    if(media.tagName==='VIDEO'){media.controls=true;media.autoplay=false;media.muted=true}
    head.querySelector('button').onclick=()=>overlay.remove(); overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
    box.append(head,media); overlay.appendChild(box); document.body.appendChild(overlay);
  }

  function assetsHtml(type){
    const list=state.assets.filter(a=>a.asset_type===type); if(!list.length)return '<div class="empty">Nenhum asset cadastrado.</div>';
    return list.map(a=>`<div class="asset"><div class="row between wrap"><div><b class="small">${esc(a.title||a.storage_path)}</b><div class="tiny muted" style="margin-top:3px">${esc(a.mime_type||'')} ${a.size_bytes?'· '+(a.size_bytes/1024/1024).toFixed(1)+' MB':''}</div></div>${a.is_default?'<span class="pill green">Padrão</span>':'<button class="btn setDefault" data-id="'+esc(a.id)+'">Definir padrão</button>'}</div><div class="row wrap" style="margin-top:9px"><button class="btn previewAsset" data-id="${esc(a.id)}">◉ Pré-visualizar</button><button class="btn renameAsset" data-id="${esc(a.id)}">✎ Renomear</button><button class="btn danger deleteAsset" data-id="${esc(a.id)}">Excluir</button></div></div>`).join('');
  }

  async function uploadAsset(type,file,progressEl){
    const {data:{session}}=await client.auth.getSession(); if(!session)throw new Error('Sessão expirada');
    const safe=(file.name||'asset').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').slice(-100);
    const path=`${type}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
    return new Promise((resolve,reject)=>{
      const up=new tus.Upload(file,{
        endpoint:`${SB_URL}/storage/v1/upload/resumable`,
        retryDelays:[0,1000,3000,5000,10000],
        headers:{authorization:`Bearer ${session.access_token}`,'x-upsert':'true'},
        uploadDataDuringCreation:true,
        removeFingerprintOnSuccess:true,
        chunkSize:6*1024*1024,
        metadata:{bucketName:BUCKET,objectName:path,contentType:file.type||'application/octet-stream',cacheControl:'3600'},
        onError:reject,
        onProgress:(sent,total)=>{if(progressEl)progressEl.style.width=Math.round(sent/total*100)+'%'},
        onSuccess:async()=>{try{await invoke({action:'register_asset',asset_type:type,storage_path:path,title:file.name,mime_type:file.type,size_bytes:file.size,set_default:true});resolve(path)}catch(e){reject(e)}}
      });
      up.findPreviousUploads().then(prev=>{if(prev.length)up.resumeFromPreviousUpload(prev[0]);up.start()}).catch(()=>up.start());
    });
  }

  function renderAssets(){
    const root=document.getElementById('view-assets'); if(!root)return;
    const rel=state.masterRelease||{};
    const releaseUrl=rel.loop_url||'https://github.com/thebusinessflowtv/theofficemusic/releases/download/office-assets-v1/office-music-master-loop.mp4';
    const releaseSize=Number(rel.loop_size_bytes||517903191);
    const releaseDigest=String(rel.loop_digest||'');
    const officialMaster=`<div class="asset"><div class="row between wrap"><div><b class="small">office-music-master-loop.mp4</b><div class="tiny muted" style="margin-top:3px">GitHub Release · office-assets-v1 · ${(releaseSize/1024/1024).toFixed(1)} MB</div>${releaseDigest?`<div class="tiny muted" style="margin-top:3px">${esc(releaseDigest)}</div>`:''}</div><span class="pill green">Padrão oficial</span></div><div class="row wrap" style="margin-top:9px"><a class="btn" target="_blank" rel="noopener" href="${esc(releaseUrl)}">↗ Abrir asset</a><span class="pill blue">GitHub Releases</span></div></div>`;
    const customLoops=state.assets.some(a=>a.asset_type==='loop')?assetsHtml('loop'):'';
    root.innerHTML=`<div class="grid grid2"><div class="grid"><div class="card pad"><h3 class="section-title">Master visual em loop</h3><p class="small muted">O master visual oficial é puxado automaticamente do GitHub Release <b>office-assets-v1</b> e usado em cada render e live. O upload abaixo fica disponível apenas para alternativas personalizadas.</p><div class="list" style="margin:12px 0">${officialMaster}${customLoops}</div><label class="assetdrop" for="loopFile"><b class="small">Enviar master alternativo MP4/MOV</b><div class="tiny muted" style="margin-top:5px">Aceita até 1 GB · recomendado 16:9</div><input id="loopFile" type="file" accept="video/mp4,video/quicktime"><div class="uploadbar"><span id="loopProgress"></span></div></label></div></div><div class="grid"><div class="card pad"><h3 class="section-title">Thumbnail padrão</h3><p class="small muted">A thumbnail selecionada é usada automaticamente nos vídeos e pode ser escolhida na live. Ao enviar uma nova imagem, o nome inicial do asset será exatamente o nome do arquivo.</p><label class="assetdrop" for="thumbFile"><b class="small">Selecionar JPG/PNG/WEBP</b><div class="tiny muted" style="margin-top:5px">Recomendado 1280×720 ou maior</div><input id="thumbFile" type="file" accept="image/jpeg,image/png,image/webp"><div class="uploadbar"><span id="thumbProgress"></span></div></label><div class="list" style="margin-top:12px">${assetsHtml('thumbnail')}</div></div></div></div>`;
    const wire=(id,type,pid)=>{const input=root.querySelector('#'+id);input.onchange=async()=>{const f=input.files?.[0];if(!f)return;const bar=root.querySelector('#'+pid);try{toast('Upload iniciado',f.name);await uploadAsset(type,f,bar);toast('Asset salvo',type==='loop'?'Novo master visual definido como padrão.':'Nova thumbnail definida como padrão.');await refresh()}catch(e){toast('Falha no upload',e.message||String(e),'error');bar.style.width='0%'}}};
    wire('loopFile','loop','loopProgress');
    wire('thumbFile','thumbnail','thumbProgress');
    root.querySelectorAll('.setDefault').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await invoke({action:'set_default_asset',asset_id:b.dataset.id});toast('Padrão atualizado');await refresh()}catch(e){toast('Falha',e.message||String(e),'error');b.disabled=false}});
    root.querySelectorAll('.previewAsset').forEach(b=>b.onclick=()=>{const a=state.assets.find(x=>x.id===b.dataset.id);if(a)openAssetPreview(a)});
    root.querySelectorAll('.renameAsset').forEach(b=>b.onclick=async()=>{const a=state.assets.find(x=>x.id===b.dataset.id);if(!a)return;const title=(prompt('Novo nome do asset:',a.title||'')||'').trim();if(!title||title===a.title)return;b.disabled=true;try{const {error}=await client.rpc('rename_office_music_asset',{p_asset_id:a.id,p_title:title});if(error)throw error;toast('Asset renomeado',title);await refresh()}catch(e){toast('Falha ao renomear',e.message||String(e),'error');b.disabled=false}});
    root.querySelectorAll('.deleteAsset').forEach(b=>b.onclick=async()=>{if(!confirm('Excluir este asset permanentemente?'))return;b.disabled=true;try{await invoke({action:'delete_asset',asset_id:b.dataset.id});toast('Asset excluído');await refresh()}catch(e){toast('Falha ao excluir',e.message||String(e),'error');b.disabled=false}});
  }

  async function refresh(){
    try{await loadData(true);tab(state.tab);schedule()}catch(e){toast('Falha ao atualizar',e.message||String(e),'error')}
  }
  function schedule(){clearInterval(refreshTimer);if(state.jobs.some(j=>!terminal.has(j.status))||state.lives.some(l=>liveActive(l.status)))refreshTimer=setInterval(refresh,15000)}

  async function boot(){
    const s=await auth(); if(!s)return;
    document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
    try{await loadData(true);tab('generate');schedule()}catch(e){toast('Falha ao carregar The Office Music',e.message||String(e),'error')}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
