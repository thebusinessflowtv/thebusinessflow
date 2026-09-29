(()=>{
  const OFFICE_HASH='#/settings?tab=office-music';
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let refreshTimer=null;
  const done=new Set(['completed','failed']);
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const fmt=d=>d?new Date(d).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const mins=s=>Math.max(1,Math.round(Number(s||0)/60));

  function addStyles(){
    if(document.getElementById('office-music-styles'))return;
    const style=document.createElement('style');
    style.id='office-music-styles';
    style.textContent=`
      .om-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,.75fr);gap:16px}
      .om-hero{padding:22px;background:linear-gradient(135deg,rgba(91,149,255,.08),rgba(128,103,238,.12));border:1px solid var(--line);border-radius:var(--r)}
      .om-big{font-size:42px;font-weight:750;letter-spacing:-.05em;line-height:1}.om-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
      .om-quick{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.om-chip{border:1px solid var(--line2);background:#11141b;color:var(--muted);border-radius:999px;padding:7px 11px;font-size:11px}.om-chip:hover,.om-chip.on{border-color:#766af7;color:var(--txt);background:rgba(118,106,247,.09)}
      .om-job{padding:14px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.018)}.om-job+.om-job{margin-top:9px}.om-progress{height:7px;background:#1e222c;border-radius:999px;overflow:hidden;margin-top:9px}.om-progress span{height:100%;display:block;background:linear-gradient(90deg,#579fff,#8f72ff);border-radius:999px}
      .om-track{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(37,41,56,.7)}.om-track:last-child{border-bottom:0}
      .om-live{opacity:.7}.om-note{border:1px solid rgba(95,211,160,.23);background:rgba(95,211,160,.06);border-radius:10px;padding:11px;color:#b8e8d3;font-size:12px;line-height:1.45}
      @media(max-width:900px){.om-grid{grid-template-columns:1fr}.om-track{grid-template-columns:minmax(0,1fr) auto}.om-track .om-download{grid-column:1/-1}}
    `;
    document.head.appendChild(style);
  }

  function toastLocal(title,text,type='success'){
    const root=document.getElementById('toasts'); if(!root)return;
    const el=document.createElement('div'); el.className='toast '+(type==='error'?'error':'success');
    el.innerHTML='<b>'+esc(title)+'</b><div class="muted">'+esc(text||'')+'</div>'; root.appendChild(el);
    setTimeout(()=>el.remove(),4200);
  }

  async function invoke(body){
    const {data,error}=await client.functions.invoke('office-music-control',{body});
    if(error)throw error;
    if(data&&data.error)throw new Error(data.message||data.error);
    return data;
  }

  function ensureNav(){
    const nav=document.querySelector('.sidebar .nav'); if(!nav)return;
    let link=document.getElementById('officeMusicNav');
    if(!link){
      link=document.createElement('a'); link.id='officeMusicNav'; link.href=OFFICE_HASH; link.innerHTML='<span class="ico">♫</span>The Office Music';
      nav.appendChild(link);
    }
    const active=location.hash.includes('tab=office-music');
    if(active){document.querySelectorAll('.sidebar .nav a').forEach(a=>a.classList.remove('active'));link.classList.add('active')}
  }

  async function loadData(){
    const [jobsR,tracksR]=await Promise.all([
      client.from('office_music_jobs').select('*').order('created_at',{ascending:false}).limit(20),
      client.from('office_music_tracks').select('*').order('created_at',{ascending:false}).limit(80)
    ]);
    if(jobsR.error)throw jobsR.error;if(tracksR.error)throw tracksR.error;
    return {jobs:jobsR.data||[],tracks:tracksR.data||[]};
  }

  function statusTone(s){return s==='completed'?'p-success':s==='failed'?'p-danger':s==='queued'?'p-warning':'p-violet'}
  function statusLabel(s){return({queued:'Na fila',generating:'Gerando músicas',rendering:'Renderizando 4K',uploading:'Enviando ao YouTube',completed:'Concluído',failed:'Falhou'}[s]||s||'—')}

  async function syncActive(jobs){
    const active=jobs.filter(j=>!done.has(j.status));
    for(const j of active.slice(0,4)){
      try{await invoke({action:'sync_job',job_id:j.id})}catch(e){console.warn('Office Music sync failed',e)}
    }
  }

  function jobsHtml(jobs){
    if(!jobs.length)return '<div class="small muted">Nenhuma geração ainda.</div>';
    return jobs.slice(0,8).map(j=>{
      const yt=j.youtube_url?'<a class="btn" target="_blank" rel="noopener" href="'+esc(j.youtube_url)+'">▶ YouTube</a>':'';
      const gh=j.github_run_url?'<a class="btn" target="_blank" rel="noopener" href="'+esc(j.github_run_url)+'">⌘ GitHub</a>':'';
      return '<div class="om-job"><div class="row between wrap"><div><b class="small">'+esc(j.title||('Mix de '+j.requested_duration_minutes+' min'))+'</b><div class="tiny muted" style="margin-top:3px">'+fmt(j.created_at)+' · '+j.requested_duration_minutes+' min · '+j.requested_tracks+' faixas solicitadas</div></div><span class="pill '+statusTone(j.status)+'">'+esc(statusLabel(j.status))+'</span></div><div class="om-progress"><span style="width:'+Math.max(0,Math.min(100,Number(j.progress)||0))+'%"></span></div>'+(j.error_message?'<div class="alert danger" style="margin-top:9px">'+esc(j.error_message)+'</div>':'')+((yt||gh)?'<div class="row wrap" style="margin-top:10px">'+yt+gh+'</div>':'')+'</div>'
    }).join('')
  }

  function tracksHtml(tracks){
    if(!tracks.length)return '<div class="small muted">As músicas geradas aparecerão aqui quando o primeiro job concluir.</div>';
    return tracks.slice(0,30).map(t=>{
      const meta=t.metadata||{}; const url=meta.download_url||t.github_path||'';
      return '<div class="om-track"><div><b class="small">'+esc(t.title)+'</b><div class="tiny muted">'+mins(t.duration_seconds)+' min'+(t.bpm?' · '+esc(t.bpm)+' BPM':'')+'</div></div><span class="pill p-violet">Original</span>'+(url?'<a class="btn om-download" target="_blank" rel="noopener" href="'+esc(url)+'">↓ Baixar</a>':'<span class="tiny muted om-download">salva no GitHub</span>')+'</div>'
    }).join('')
  }

  async function renderOffice(){
    if(!location.hash.includes('tab=office-music'))return;
    addStyles();ensureNav();
    const page=document.querySelector('.page'); if(!page)return;
    const crumb=document.querySelector('.crumb b'); if(crumb)crumb.textContent='The Office Music';
    page.innerHTML='<div class="pagehead"><div><h1>The Office Music</h1><p>Gere uma sessão completa e publique automaticamente em 4K no YouTube.</p></div><span class="pill p-success">YouTube conectado</span></div><div class="card pad"><div class="row" style="justify-content:center;padding:44px"><div class="loader"></div></div></div>';
    try{
      let data=await loadData();
      await syncActive(data.jobs); data=await loadData();
      page.innerHTML=`
        <div class="pagehead"><div><h1>The Office Music</h1><p>Geração, renderização 4K e publicação automática no canal.</p></div><span class="pill p-success">YouTube conectado</span></div>
        <div class="om-grid">
          <div class="grid">
            <div class="om-hero">
              <div class="om-label">Music Generator</div>
              <div style="margin-top:14px" class="grid grid2">
                <div>
                  <label>Duração total</label>
                  <div class="row"><input id="omDuration" class="input" type="number" min="6" max="360" step="1" value="60"><span class="muted small">min</span></div>
                  <div class="om-quick">${[30,60,90,120].map(v=>'<button class="om-chip '+(v===60?'on':'')+'" data-min="'+v+'">'+v+' min</button>').join('')}</div>
                </div>
                <div class="metricbox"><small>PUBLICAÇÃO</small><b class="small">Automática e pública</b><div class="tiny muted" style="margin-top:7px">Música → mix → vídeo 4K → YouTube</div></div>
              </div>
              <div class="om-note" style="margin-top:16px">O render 4K usa um master visual curto codificado uma única vez e depois faz stream-copy do vídeo. Isso evita renderizações de horas para mixes longos.</div>
              <button class="btn primary block" id="omGenerate" style="margin-top:16px;min-height:44px">♫ Gerar música e publicar</button>
            </div>
            <div class="card pad"><div class="row between"><h3 class="small">Gerações</h3><button class="btn" id="omRefresh">↻ Atualizar</button></div><div id="omJobs" style="margin-top:13px">${jobsHtml(data.jobs)}</div></div>
          </div>
          <div class="grid">
            <div class="card pad"><div class="row between"><h3 class="small">Biblioteca de músicas</h3><span class="pill">GitHub</span></div><div id="omTracks" style="margin-top:10px">${tracksHtml(data.tracks)}</div></div>
            <div class="card pad om-live"><div class="row between"><h3 class="small">Live</h3><span class="pill p-warning">Fase 2</span></div><p class="small muted" style="line-height:1.5">A biblioteca já está preparada para selecionar faixas. A transmissão contínua precisa do worker persistente de streaming para não depender do limite do GitHub Actions.</p></div>
          </div>
        </div>`;
      document.querySelectorAll('.om-chip').forEach(b=>b.onclick=()=>{document.getElementById('omDuration').value=b.dataset.min;document.querySelectorAll('.om-chip').forEach(x=>x.classList.toggle('on',x===b))});
      document.getElementById('omRefresh').onclick=renderOffice;
      document.getElementById('omGenerate').onclick=async()=>{
        const btn=document.getElementById('omGenerate');const duration=Math.max(6,Math.min(360,Number(document.getElementById('omDuration').value||60)));
        btn.disabled=true;btn.textContent='Criando job…';
        try{
          const r=await invoke({action:'create_job',duration_minutes:duration,publish:true,privacy:'public'});
          toastLocal('Geração iniciada',duration+' minutos · publicação pública automática');
          await renderOffice();
        }catch(e){toastLocal('Falha ao iniciar',e.message||String(e),'error');btn.disabled=false;btn.textContent='♫ Gerar música e publicar'}
      };
      clearInterval(refreshTimer);
      if(data.jobs.some(j=>!done.has(j.status))) refreshTimer=setInterval(()=>{if(location.hash.includes('tab=office-music'))renderOffice()},15000);
    }catch(e){page.innerHTML='<div class="pagehead"><div><h1>The Office Music</h1><p>Geração e publicação automática.</p></div></div><div class="card pad"><div class="alert danger"><b>Falha ao carregar</b><div style="margin-top:5px">'+esc(e.message||e)+'</div></div></div>'}
  }

  function boot(){
    ensureNav();
    if(location.hash.includes('tab=office-music'))setTimeout(renderOffice,80);
    const obs=new MutationObserver(()=>{ensureNav();if(location.hash.includes('tab=office-music')){const h=document.querySelector('.pagehead h1');if(!h||h.textContent!=='The Office Music')setTimeout(renderOffice,30)}});
    obs.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('hashchange',()=>{clearInterval(refreshTimer);setTimeout(()=>{ensureNav();if(location.hash.includes('tab=office-music'))renderOffice()},80)});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
