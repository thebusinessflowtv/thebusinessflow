(()=>{
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const ANALYTICS='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/live-analytics.json';
  const RAW='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control';
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let platform='youtube';
  let state={tracks:[],lives:[],assets:[],playlists:[],analytics:null,kickResults:{}};
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const fmt=d=>d?new Date(d).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const urlOf=t=>String(t?.metadata?.download_url||t?.github_path||'');
  const isKick=l=>String(l?.title||'').startsWith('[KICK]')||String(l?.description||'').startsWith('[platform:kick]');
  const cleanTitle=l=>String(l?.title||'Peter Lofi — Live').replace(/^\[KICK\]\s*/,'');
  const active=s=>['queued','starting','live','reconnecting','stopping'].includes(s);

  async function invoke(body){
    const fn=(body.action==='start_live')?'office-music-queue-control':'office-music-control';
    const {data,error}=await client.functions.invoke(fn,{body});
    if(error)throw error;if(data?.error)throw new Error(data.message||data.error);return data;
  }
  async function fetchJson(url){try{const r=await fetch(url+'?v='+Date.now(),{cache:'no-store'});if(!r.ok)return null;return await r.json()}catch{return null}}
  async function auth(){const {data:{session}}=await client.auth.getSession();if(!session){location.href='./index.html';return null}document.getElementById('userBox').textContent=session.user?.email||'Administrador';return session}
  async function load(){
    const [tr,li,as,pl,an]=await Promise.all([
      client.from('office_music_tracks').select('*').order('created_at',{ascending:false}).limit(250),
      client.from('office_music_live_sessions').select('*').order('created_at',{ascending:false}).limit(60),
      client.from('office_music_assets').select('*').order('created_at',{ascending:false}).limit(100),
      client.from('office_music_playlists').select('*').order('created_at',{ascending:false}).limit(100),
      fetchJson(ANALYTICS)
    ]);
    for(const r of [tr,li,as,pl])if(r.error)throw r.error;
    state.tracks=tr.data||[];state.lives=li.data||[];state.assets=as.data||[];state.playlists=pl.data||[];state.analytics=an;
    const ytActive=state.lives.filter(l=>!isKick(l)&&active(l.status)).slice(0,4);
    await Promise.allSettled(ytActive.map(l=>invoke({action:'sync_live',session_id:l.id})));
    if(ytActive.length){const r=await client.from('office_music_live_sessions').select('*').order('created_at',{ascending:false}).limit(60);if(!r.error)state.lives=r.data||[]}
    const kicks=state.lives.filter(isKick).slice(0,15);
    const entries=await Promise.all(kicks.map(async l=>[l.id,await fetchJson(`${RAW}/kick-live-results/${l.id}.json`)]));
    state.kickResults=Object.fromEntries(entries.filter(x=>x[1]));
  }
  function effective(l){if(isKick(l)&&state.kickResults[l.id])return {...l,...state.kickResults[l.id],title:cleanTitle(l)};return l}
  function trackPicker(){return state.tracks.filter(t=>urlOf(t)).map(t=>`<label class="track"><input class="pick" type="checkbox" value="${esc(t.id)}"><div><b class="small">${esc(t.title||t.filename||'Faixa')}</b><div class="tiny muted">${Math.max(1,Math.round(Number(t.duration_seconds||0)/60))} min · ${esc(t.style||'Peter Lofi')}</div></div><span class="tiny muted">♫</span></label>`).join('')||'<div class="note">Nenhuma faixa disponível na biblioteca.</div>'}
  function playlistOptions(){return state.playlists.map(p=>`<option value="${esc(p.id)}">${esc(p.name||'Playlist')} · ${(p.track_ids||[]).length} faixas</option>`).join('')}
  function thumbOptions(){return state.assets.filter(a=>a.asset_type==='thumbnail').map(a=>`<option value="${esc(a.id)}" ${a.is_default?'selected':''}>${esc(a.title||'Thumbnail')}</option>`).join('')}
  function ytMetric(l){const sessions=state.analytics?.youtube?.sessions||[];return sessions.find(x=>String(x.session_id)===String(l.id))?.data||null}
  function kickChannel(){return state.analytics?.kick?.channel||null}
  function num(v){if(v==null||v==='')return '—';const n=Number(v);return Number.isFinite(n)?n.toLocaleString('pt-BR'):String(v)}
  function liveMetrics(l){
    if(isKick(l)){
      const c=kickChannel();const s=c?.stream||{};
      return [{k:'ONLINE',v:num(s.viewer_count??c?.viewer_count)},{k:'SEGUIDORES',v:num(c?.followers_count??c?.followers)},{k:'INSCRITOS',v:num(c?.active_subscribers_count)},{k:'CATEGORIA',v:c?.category?.name||'—'}];
    }
    const d=ytMetric(l),st=d?.statistics||{},ls=d?.liveStreamingDetails||{};
    return [{k:'ONLINE',v:num(ls.concurrentViewers)},{k:'VISUALIZAÇÕES',v:num(st.viewCount)},{k:'LIKES',v:num(st.likeCount)},{k:'COMENTÁRIOS',v:num(st.commentCount)}];
  }
  function statusOf(l){return effective(l).status||'queued'}
  function livesFor(p){return state.lives.filter(l=>p==='kick'?isKick(l):!isKick(l)).map(effective)}
  function liveCards(p){
    const list=livesFor(p);if(!list.length)return '<div class="note">Nenhuma live registrada nesta plataforma ainda.</div>';
    return list.map(l=>{const st=statusOf(l);const metrics=liveMetrics(l);return `<article class="card livecard" data-id="${esc(l.id)}"><div class="row between wrap"><div><b class="small">${esc(cleanTitle(l))}</b><div class="tiny muted">${fmt(l.created_at||l.started_at)} · ${l.duration_minutes==null?'contínua':esc(l.duration_minutes)+' min'}</div></div><span class="pill ${esc(st)}">${esc(st==='live'?'AO VIVO':st)}</span></div><div class="metrics">${metrics.map(m=>`<div class="metric"><small>${esc(m.k)}</small><b>${esc(m.v)}</b></div>`).join('')}</div>${active(st)?`<div class="row" style="margin-top:10px"><button class="btn danger stop" data-id="${esc(l.id)}">Encerrar</button></div>`:''}</article>`}).join('')
  }
  function form(p){
    const kick=p==='kick';
    const desc=kick?'A descrição fica registrada no MediaForge. A Kick usa título/categoria de stream; a atualização automática do título fica habilitada quando o OAuth da Kick for conectado.':'Stylish original Peter Lofi beats for work, focus, study and late-night sessions.\n\n🎧 Subscribe to Peter Lofi:\nhttps://www.youtube.com/@PeterLofiSounds\n\n#PeterLofi #Lofi #LofiMusic #FocusMusic';
    return `<div class="grid grid2"><section class="card"><div class="row"><span class="dot ${kick?'kick':''}"></span><b>${kick?'Kick Live':'YouTube Live'}</b></div><div class="field"><label>TÍTULO</label><input id="title" class="input" maxlength="120" value="Peter Lofi — ${kick?'Kick Live':'Live Lofi Radio'} 🎧"></div><div class="field"><label>DESCRIÇÃO / NOTAS</label><textarea id="description" class="input" rows="5">${esc(desc)}</textarea></div><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div class="field"><label>DURAÇÃO</label><select id="duration" class="select"><option value="60">1 hora</option><option value="120">2 horas</option><option value="180">3 horas</option><option value="360">6 horas</option><option value="720">12 horas</option><option value="0">Contínua</option></select></div><div class="field"><label>THUMBNAIL</label><select id="thumb" class="select"><option value="">Padrão</option>${thumbOptions()}</select></div></div><div class="field"><label>PLAYLIST SALVA</label><select id="playlist" class="select"><option value="">Seleção manual</option>${playlistOptions()}</select></div><div class="row between wrap" style="margin-top:13px"><div class="small"><b>Músicas da live</b><div class="tiny muted">A playlist reinicia automaticamente.</div></div><div class="row"><button id="all" class="btn" type="button">Selecionar tudo</button><button id="none" class="btn" type="button">Limpar</button></div></div><div class="tracklist">${trackPicker()}</div>${kick?'<div class="note" style="margin-top:12px"><b>Motor Kick instalado:</b> RTMPS 1080p/30, H.264, CBR 6 Mbps e áudio AAC. Para transmitir de verdade falta apenas conectar as credenciais da sua conta Kick.</div>':''}<button id="start" class="btn ${kick?'kick':'primary'} block" style="margin-top:14px" ${state.tracks.some(t=>urlOf(t))?'':'disabled'}>${kick?'● Iniciar na Kick':'▶ Iniciar no YouTube'}</button></section><section class="grid"><div class="card"><div class="row between"><b>Lives ${kick?'na Kick':'no YouTube'}</b><span class="tiny muted">clique em uma live para detalhes</span></div><div class="grid" style="margin-top:12px">${liveCards(p)}</div></div><div class="card"><b>Analytics</b><div class="note" style="margin-top:10px">${analyticsNote(p)}</div></div></section></div>`
  }
  function analyticsNote(p){
    if(p==='kick')return state.analytics?.kick?.configured?'Snapshot da API Kick ativo. Viewers, seguidores, inscritos, categoria e dados disponíveis do canal são atualizados pelo coletor.':'O painel já está preparado. Para ativar analytics da Kick, conecte o app OAuth/API da Kick conforme as credenciais listadas abaixo.';
    return state.analytics?.youtube?.configured?'YouTube Data API conectada. O painel coleta viewers simultâneos, visualizações, likes, comentários e dados da transmissão.':'O painel está pronto, mas o snapshot de analytics ainda não encontrou as credenciais OAuth no coletor.';
  }
  function render(){
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.platform===platform));
    document.getElementById('content').innerHTML=form(platform);
    const root=document.getElementById('content');
    root.querySelector('#all').onclick=()=>root.querySelectorAll('.pick').forEach(x=>x.checked=true);
    root.querySelector('#none').onclick=()=>root.querySelectorAll('.pick').forEach(x=>x.checked=false);
    root.querySelector('#playlist').onchange=e=>{const p=state.playlists.find(x=>String(x.id)===String(e.target.value));root.querySelectorAll('.pick').forEach(x=>x.checked=!!p&&(p.track_ids||[]).map(String).includes(String(x.value)))};
    root.querySelector('#start').onclick=start;
    root.querySelectorAll('.stop').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(!confirm('Encerrar esta live agora?'))return;b.disabled=true;try{await invoke({action:'stop_live',session_id:b.dataset.id});alert('Encerramento solicitado.');setTimeout(refresh,1500)}catch(err){alert('Falha: '+(err.message||err));b.disabled=false}});
    root.querySelectorAll('.livecard').forEach(c=>c.onclick=()=>showDetail(c.dataset.id));
  }
  async function start(){
    const root=document.getElementById('content');const btn=root.querySelector('#start');
    const ids=[...root.querySelectorAll('.pick:checked')].map(x=>x.value);if(!ids.length){alert('Selecione pelo menos uma música.');return}
    const d=Number(root.querySelector('#duration').value);let title=root.querySelector('#title').value.trim()||'Peter Lofi — Live';let description=root.querySelector('#description').value;
    if(platform==='kick'){title='[KICK] '+title;description='[platform:kick]\n'+description}
    btn.disabled=true;btn.textContent='Preparando…';
    try{await invoke({action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title,description,thumbnail_asset_id:root.querySelector('#thumb').value||null});alert(platform==='kick'?'Live da Kick enviada para a fila. Se a Stream Key já estiver configurada, o encoder iniciará automaticamente.':'Live do YouTube enviada para a fila.');await refresh()}catch(e){alert('Falha ao iniciar: '+(e.message||e));btn.disabled=false;render()}
  }
  function showDetail(id){
    const original=state.lives.find(l=>String(l.id)===String(id));if(!original)return;const l=effective(original);const kick=isKick(original);const metrics=liveMetrics(original);const yt=kick?null:ytMetric(original);const kc=kickChannel();
    const root=document.getElementById('modalRoot');root.innerHTML=`<div class="modal"><div class="modalbox"><button class="btn close">✕ Fechar</button><div class="row"><span class="dot ${kick?'kick':''}"></span><b>${kick?'Kick':'YouTube'} · ${esc(cleanTitle(original))}</b></div><div class="tiny muted" style="margin-top:5px">Sessão ${esc(id)} · status ${esc(l.status||original.status||'—')}</div><div class="metrics">${metrics.map(m=>`<div class="metric"><small>${esc(m.k)}</small><b>${esc(m.v)}</b></div>`).join('')}</div><div class="card" style="margin-top:12px"><b class="small">Informações da transmissão</b><div class="tiny muted" style="line-height:1.8;margin-top:8px">Início: ${esc(fmt(l.live_at||l.started_at||original.created_at))}<br>Duração configurada: ${original.duration_minutes==null?'contínua':esc(original.duration_minutes)+' min'}<br>${kick?`Canal Kick: ${esc(state.analytics?.kick?.channel_slug||'a conectar')}<br>Título API: ${esc(kc?.stream_title||kc?.stream?.title||'—')}`:`URL: ${yt?.id?`https://youtube.com/watch?v=${esc(yt.id)}`:esc(l.youtube_url||'—')}<br>Status YouTube: ${esc(yt?.status?.uploadStatus||yt?.snippet?.liveBroadcastContent||'—')}`}</div></div><div class="note" style="margin-top:12px">${kick?'A Kick não possui “likes” equivalentes ao YouTube no mesmo formato. Mostramos viewers simultâneos, seguidores, inscritos, categoria e os campos disponibilizados pela API/analytics conectada.':'Os números básicos vêm da YouTube Data API. Métricas avançadas como watch time e duração média exigem também a autorização YouTube Analytics (yt-analytics.readonly).'}</div></div></div>`;root.querySelector('.close').onclick=()=>root.innerHTML='';root.querySelector('.modal').onclick=e=>{if(e.target===root.querySelector('.modal'))root.innerHTML=''};
  }
  async function refresh(){try{await load();render()}catch(e){document.getElementById('content').innerHTML='<div class="card" style="color:#ffb2ba">Erro ao carregar a central de lives: '+esc(e.message||e)+'</div>'}}
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{platform=b.dataset.platform;render()});document.getElementById('refresh').onclick=refresh;
  auth().then(s=>s&&refresh());setInterval(refresh,60000);
})();
