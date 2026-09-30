(()=>{
  const RAW='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main';
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const statusLabel=s=>({completed:'Concluída',generating:'Gerando agora',failed:'Falhou',pending:'Na fila'}[s]||s||'Na fila');
  async function getJson(url){const r=await fetch(url+(url.includes('?')?'&':'?')+'v='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error(String(r.status));return r.json()}
  function resultPath(item){return `${RAW}/control/series-results/${String(item.index).padStart(2,'0')}-${item.key}.json`}
  function fmtDuration(sec){sec=Number(sec||0);const m=Math.floor(sec/60),s=Math.round(sec%60);return `${m}:${String(s).padStart(2,'0')}`}
  function trackRows(tracks){return (tracks||[]).map((t,i)=>`<div class="track"><div><b>${String(i+1).padStart(2,'0')} · ${esc((t.title||t.filename||'Faixa').replace(/^\d+[-_]/,''))}</b><span class="tiny muted">${t.duration_seconds?` · ${fmtDuration(t.duration_seconds)}`:''}</span></div>${t.download_url?`<a class="btn" href="${esc(t.download_url)}" target="_blank" rel="noopener">↓ WAV</a>`:''}</div>`).join('')}
  async function load(){
    const root=document.getElementById('list');
    try{
      const plan=await getJson(`${RAW}/config/peter_lofi_series.json`);
      const items=plan.series||[];
      const results=await Promise.all(items.map(async item=>{try{return await getJson(resultPath(item))}catch{return null}}));
      let done=0,running=0,availableTracks=0;
      root.innerHTML=items.map((item,i)=>{
        const r=results[i];const st=r?.status||'pending';if(st==='completed')done++;if(st==='generating')running++;availableTracks+=(r?.tracks||[]).length;
        const pct=Number(r?.progress||0);
        const master=r?.master_audio_url?`<a class="btn primary" target="_blank" rel="noopener" href="${esc(r.master_audio_url)}">↓ Baixar master 60 min</a>`:'';
        const rel=r?.release_url?`<a class="btn" target="_blank" rel="noopener" href="${esc(r.release_url)}">GitHub Release</a>`:'';
        const run=r?.github_run_url?`<a class="btn" target="_blank" rel="noopener" href="${esc(r.github_run_url)}">⌘ Execução</a>`:'';
        const tracks=(r?.tracks||[]).length?`<button class="btn tracksBtn" data-i="${i}">Faixas individuais (${r.tracks.length})</button>`:'';
        const phase=r?.phase?`<div class="phase ${esc(st)}">${st==='generating'?'● ':''}${esc(r.phase)}</div>`:'';
        const engine=st==='generating'||r?.generation_mode?`<div class="tiny muted engine">Motor: ${esc(r?.generation_mode||'Stable Audio 3 Small-Music')} · áudio 100% novo · sem reutilização/loop de faixas antigas</div>`:'';
        return `<article class="card"><div class="row between wrap"><div><div class="tiny muted">SÉRIE ${String(item.index).padStart(2,'0')} · ${esc(item.name)}</div><b class="small">${esc(item.title)}</b><div class="tiny muted" style="margin-top:4px">Playlist: ${esc(item.playlist)}</div></div><span class="pill ${esc(st)}">${esc(statusLabel(st))}</span></div><div class="desc">${esc(item.description)}</div><div class="progress"><span style="width:${Math.min(100,Math.max(0,pct))}%"></span></div>${phase}${engine}${r?.error_message?`<div class="errorbox">${esc(r.error_message)}</div>`:''}<div class="links">${master}${rel}${run}${tracks}</div><div id="tracks-${i}" class="tracks">${trackRows(r?.tracks)}</div></article>`;
      }).join('');
      document.getElementById('done').textContent=String(done);
      document.getElementById('running').textContent=String(running);
      const tf=document.getElementById('tracksReady');if(tf)tf.textContent=String(availableTracks);
      const lu=document.getElementById('lastUpdate');if(lu)lu.textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      document.querySelectorAll('.tracksBtn').forEach(b=>b.onclick=()=>document.getElementById('tracks-'+b.dataset.i)?.classList.toggle('open'));
    }catch(e){root.innerHTML='<div class="card small" style="color:#ffadb5">Não foi possível carregar as séries agora: '+esc(e.message)+'</div>'}
  }
  document.getElementById('refresh').onclick=load;load();setInterval(load,20000);
})();
