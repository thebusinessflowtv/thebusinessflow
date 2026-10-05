(()=>{
  const API=(location.hostname==='peterlofi.odsgn.com.br'?location.origin:(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'https://mediaforge-api.guilhermeodsgn.workers.dev')).replace(/\/$/,'');
  const TOKEN_KEY='mediaforge_token';
  let presets=[],jobs=[],timer=null;

  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=d=>{try{return new Date(d).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}catch(_){return d||'—'}};
  const tone=s=>s==='completed'?'green':s==='failed'?'red':s==='queued'?'amber':'blue';
  const label=s=>({queued:'Na fila',generating:'Gerando',completed:'Concluída',failed:'Falhou'}[s]||s||'—');

  function toast(title,text='',type='ok'){
    const root=document.getElementById('toasts');if(!root)return;
    const el=document.createElement('div');el.className='toast'+(type==='error'?' error':'');
    el.innerHTML='<b>'+esc(title)+'</b><div class="muted">'+esc(text)+'</div>';root.appendChild(el);setTimeout(()=>el.remove(),5000);
  }

  async function api(path,opt={}){
    const headers={...(opt.headers||{}),authorization:'Bearer '+(localStorage.getItem(TOKEN_KEY)||'')};
    if(opt.body&&!headers['content-type'])headers['content-type']='application/json';
    const res=await fetch(API+path,{...opt,headers,cache:'no-store'});
    let data=null;try{data=await res.json()}catch(_){}
    if(res.status===401){localStorage.removeItem(TOKEN_KEY);location.replace('./secure.html?return='+encodeURIComponent('./app.html#/peter-lofi/music'));throw new Error('Sessão expirada.');}
    if(!res.ok)throw new Error(data?.message||data?.error||('HTTP '+res.status));
    return data;
  }

  function jobsHtml(){
    if(!jobs.length)return '<div class="empty">Nenhuma geração criada por este novo gerador ainda.</div>';
    return jobs.map(j=>{
      const result=j.result||{};
      const tracks=result.tracks||[];
      const links=[];
      if(j.github_run_url||result.github_run_url)links.push('<a class="btn" target="_blank" rel="noopener" href="'+esc(j.github_run_url||result.github_run_url)+'">⌘ Execução</a>');
      if(j.master_audio_url||result.master_audio_url)links.push('<a class="btn" target="_blank" rel="noopener" href="'+esc(j.master_audio_url||result.master_audio_url)+'">♫ Master</a>');
      if(result.release_url)links.push('<a class="btn" target="_blank" rel="noopener" href="'+esc(result.release_url)+'">GitHub Release</a>');
      return '<div class="job"><div class="row between wrap"><div><b class="small">'+esc(j.playlist_name)+'</b><div class="tiny muted" style="margin-top:4px">'+esc(j.series_key)+' · '+esc(j.duration_minutes)+' min · '+fmt(j.created_at)+(tracks.length?' · '+tracks.length+' faixas':'')+'</div></div><span class="pill '+tone(j.status)+'">'+esc(label(j.status))+'</span></div><div class="progress"><span style="width:'+Math.max(0,Math.min(100,Number(j.progress)||0))+'%"></span></div><div class="tiny muted" style="margin-top:7px">'+esc(j.phase||'')+'</div>'+(j.error?'<div class="note" style="border-color:#66353b;background:#2b181b;color:#ffadb5;margin-top:9px">'+esc(j.error)+'</div>':'')+(links.length?'<div class="row wrap" style="margin-top:10px">'+links.join('')+'</div>':'')+'</div>';
    }).join('');
  }

  function render(){
    const root=document.getElementById('view-generate');if(!root)return;
    const opts=presets.map((p,i)=>'<option value="'+esc(p.key)+'" data-name="'+esc(p.name)+'" '+(i===0?'selected':'')+'>'+esc(p.name)+' · '+esc(p.genre||'Lofi')+'</option>').join('');
    root.innerHTML='<div class="grid grid2"><div class="grid"><div class="card hero"><div class="label">PeterLofi Music Generator</div><h2 style="margin-top:8px">Gerar nova playlist</h2><p class="small muted" style="line-height:1.6;margin:6px 0 18px">Gera músicas novas e individuais no Kaggle, salva cada faixa em WAV, cria um master e cataloga automaticamente a playlist em <b>Músicas</b>.</p><div class="field"><label>ESTILO / SÉRIE</label><select id="seriesKey" class="select">'+opts+'</select></div><div class="field"><label>NOME DA PLAYLIST</label><input id="playlistName" class="input" maxlength="80" value="'+esc(presets[0]?.name||'Peter Lofi Playlist')+'"></div><div class="field"><label>DURAÇÃO TOTAL</label><select id="duration" class="select"><option value="30">30 minutos</option><option value="60" selected>1 hora</option><option value="90">1h30</option><option value="120">2 horas</option><option value="180">3 horas</option></select><div class="tiny muted" style="margin-top:6px">As músicas finais têm pelo menos 5 minutos. O master serve para vídeos longos; as lives usam as faixas individuais.</div></div><div class="grid" style="grid-template-columns:repeat(3,1fr);margin:18px 0"><div class="metric"><small>ÁUDIO</small><b>100% novo</b></div><div class="metric"><small>FAIXAS</small><b>WAV individuais</b></div><div class="metric"><small>CATÁLOGO</small><b>Automático</b></div></div><div class="note"><b>Sem Supabase.</b> A solicitação sai do MediaForge pelo Cloudflare, roda no GitHub/Kaggle e volta para a biblioteca PeterLofi. Nenhum áudio histórico é reutilizado para completar uma geração.</div><button id="generateBtn" class="btn primary block" style="margin-top:16px;min-height:45px">♫ Gerar playlist</button></div><div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Gerações recentes</h3><button id="refreshJobs" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">'+jobsHtml()+'</div></div></div><div class="grid"><div class="card pad"><h3 class="section-title">Como funciona</h3><div class="list"><div class="metric"><small>01</small><b>Escolha o estilo</b><div class="tiny muted">Gaming, Rainy, Coffee Shop, Deep Focus, Night Shift e demais presets do PeterLofi.</div></div><div class="metric"><small>02</small><b>Geração original</b><div class="tiny muted">Stable Audio Small-Music no Kaggle com seed exclusiva para a solicitação.</div></div><div class="metric"><small>03</small><b>Faixas individuais</b><div class="tiny muted">Cada música é preservada separadamente e pode ser usada nas rádios interativas.</div></div><div class="metric"><small>04</small><b>Biblioteca automática</b><div class="tiny muted">Ao terminar, a playlist aparece na página Músicas e pode ser selecionada nas lives.</div></div></div></div><div class="card pad"><h3 class="section-title">Pipeline</h3><div class="small muted" style="line-height:1.75">MediaForge → Cloudflare D1 → GitHub Actions → Kaggle → GitHub Release → Biblioteca PeterLofi.</div></div></div></div>';

    const series=root.querySelector('#seriesKey'),name=root.querySelector('#playlistName');
    series.onchange=()=>{const p=presets.find(x=>x.key===series.value);if(p)name.value=p.name};
    root.querySelector('#refreshJobs').onclick=load;
    root.querySelector('#generateBtn').onclick=async()=>{
      const btn=root.querySelector('#generateBtn');
      const seriesKey=series.value,playlistName=name.value.trim(),duration=Number(root.querySelector('#duration').value||60);
      if(!seriesKey||!playlistName){toast('Preencha a playlist','Selecione o estilo e informe um nome.','error');return}
      btn.disabled=true;btn.textContent='Enviando para geração…';
      try{
        const d=await api('/api/music/generate',{method:'POST',body:JSON.stringify({series_key:seriesKey,playlist_name:playlistName,duration_minutes:duration})});
        toast('Geração iniciada',playlistName+' · '+duration+' minutos');
        await load();
      }catch(e){toast('Falha ao iniciar',e.message||String(e),'error')}
      finally{btn.disabled=false;btn.textContent='♫ Gerar playlist'}
    };
  }

  async function load(){
    try{
      const [p,j]=await Promise.all([api('/api/music/presets'),api('/api/music/jobs')]);
      presets=p.presets||[];jobs=j.jobs||[];render();
      clearInterval(timer);
      if(jobs.some(x=>!['completed','failed'].includes(String(x.status))))timer=setInterval(load,15000);
    }catch(e){
      const root=document.getElementById('view-generate');
      if(root)root.innerHTML='<div class="note" style="border-color:#66353b;background:#2b181b;color:#ffadb5"><b>Falha ao carregar o gerador</b><br>'+esc(e.message||String(e))+'</div>';
    }
  }


  async function monitorGamingQueue(){
    let box=document.getElementById('gaming-dj30-monitor');
    if(!box){box=document.createElement('section');box.id='gaming-dj30-monitor';box.className='card pad';box.style.marginBottom='20px';document.getElementById('view-generate')?.before(box);}
    const base='https://api.github.com/repos/thebusinessflowtv/theofficemusic';
    const read=async url=>{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('Consulta de produção indisponível (HTTP '+r.status+')');return r.json();};
    try{
      const data=await read(base+'/actions/workflows/generate-gaming-dj30.yml/runs?per_page=1');
      const run=data.workflow_runs?.[0];if(!run)throw new Error('Nenhuma execução encontrada.');
      const detail=await read(base+'/actions/runs/'+run.id+'/jobs?per_page=100');
      const list=(detail.jobs||[]).sort((a,b)=>Number(a.name.match(/Track (\d+)/)?.[1]||0)-Number(b.name.match(/Track (\d+)/)?.[1]||0));
      const done=list.filter(j=>j.conclusion==='success').length;
      const failed=list.filter(j=>j.conclusion==='failure').length;
      const library=await api('/api/music-library').catch(()=>null);
      const gaming=(library?.playlists||[]).find(p=>p.key==='gaming-radio');
      const localIds=new Set((gaming?.tracks||[]).filter(t=>t.source==='gaming-twitch-dj-30'&&t.asset_id).map(t=>t.id));
      const delivered=library?localIds.size:null;
      box.innerHTML='<h3>Gaming · 30 músicas animadas</h3><p class="small muted">5 minutos por faixa · Referência: twitch-dj-mixed · '+done+'/30 áudios aprovados'+(delivered!==null?' · '+delivered+'/30 disponíveis na Gaming':' · Entrega na OVH indisponível')+(failed?' · '+failed+' com erro':'')+'</p>'+
        '<div class="list">'+list.map(j=>{const step=(j.steps||[]).find(s=>s.status==='in_progress')||(j.steps||[]).find(s=>s.conclusion==='failure');const number=Number(j.name.match(/Track (\d+)/)?.[1]||0);const id='gaming-twitch-dj-20261004-'+String(number).padStart(2,'0');const state=localIds.has(id)?'Disponível na Gaming':j.conclusion==='failure'?'Falhou':j.conclusion==='cancelled'?'Aguardando correção':j.conclusion==='success'?'Áudio aprovado · aguardando envio':j.status==='in_progress'?'Em processamento':'Na fila';return '<div class="row between wrap"><b class="small">'+esc(j.name.replace(/ —.*/,''))+'</b><span class="small">'+esc(state)+'</span>'+(step?'<div class="tiny muted" style="width:100%">'+esc(step.name)+'</div>':'')+'</div>';}).join('')+'</div>'+
        '<p class="tiny muted">Atualizado: '+esc(new Date().toLocaleTimeString('pt-BR'))+' · Atualização automática a cada minuto. As faixas aprovadas são enviadas automaticamente à Gaming na OVH.</p><a class="btn" target="_blank" rel="noopener" href="'+esc(run.html_url)+'">Ver detalhes da execução</a>';
    }catch(e){box.innerHTML='<h3>Acompanhamento Gaming</h3><p>'+esc(e.message)+'</p><a class="btn" target="_blank" rel="noopener" href="https://github.com/thebusinessflowtv/theofficemusic/actions/workflows/generate-gaming-dj30.yml">Abrir acompanhamento</a>';}
  }

  async function boot(){
    document.querySelectorAll('.tab').forEach(x=>x.style.display='none');
    ['view-live','view-library','view-assets'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
    document.getElementById('view-generate')?.classList.remove('hidden');
    await Promise.all([load(),monitorGamingQueue()]);
    setInterval(monitorGamingQueue,60000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
