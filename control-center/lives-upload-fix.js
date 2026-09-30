(()=>{
  const PROJECT_ID='fykwalznmcrjgnyveagy';
  const SB_URL=`https://${PROJECT_ID}.supabase.co`;
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const BUCKET='office-music-assets';
  const DIRECT_TUS=`https://${PROJECT_ID}.storage.supabase.co/storage/v1/upload/resumable`;
  const FREE_PLAN_LIMIT=50*1024*1024;
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let catalogPromise=null;

  const fmtBytes=n=>{const x=Number(n||0);if(x>=1024**3)return `${(x/1024**3).toFixed(2)} GB`;return `${(x/1024**2).toFixed(1)} MB`;};
  const fmtDate=d=>d?new Date(d).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}):'';
  const platformRestriction=()=>new Error('O projeto Supabase está com restrição HTTP 402 no plano Free. REST, Storage e Edge Functions ficam bloqueados enquanto a cota não for liberada. Para produção contínua e uploads grandes, aumente o plano/cota do projeto e tente novamente.');
  const fn=async(name,body)=>{
    const {data,error}=await client.functions.invoke(name,{body});
    if(error){
      const status=Number(error?.context?.status||error?.status||0);
      if(status===402)throw platformRestriction();
      let payload=null;try{payload=await error?.context?.clone?.().json()}catch(_){}
      throw new Error(payload?.message||payload?.error||error.message||'Falha no servidor');
    }
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  };
  const setStatus=(el,msg,type='muted')=>{if(!el)return;el.textContent=msg;el.style.color=type==='error'?'#ff9ca6':type==='ok'?'#8ff2bb':'#9999a2';};
  const trackUrl=t=>String(t?.metadata?.download_url||t?.metadata?.release_download_url||t?.github_path||'');

  async function fetchAll(table){
    const rows=[];let from=0;const size=1000;
    while(true){
      const q=await client.from(table).select('*').order('created_at',{ascending:false}).range(from,from+size-1);
      if(q.error){if(Number(q.error?.status||q.status||0)===402)throw platformRestriction();throw q.error;}
      rows.push(...(q.data||[]));if(!q.data||q.data.length<size)break;from+=size;
    }
    return rows;
  }
  async function catalog(){
    if(!catalogPromise)catalogPromise=Promise.all([fetchAll('office_music_tracks'),fetchAll('office_music_jobs')]).then(([tracks,jobs])=>({tracks,jobs})).catch(e=>{catalogPromise=null;throw e});
    return catalogPromise;
  }

  async function uploadVisual(file,bar,status){
    if(!window.tus)throw new Error('O módulo de upload TUS não carregou. Atualize a página.');
    const {data:{session}}=await client.auth.getSession();if(!session)throw new Error('Sessão expirada. Entre novamente no MediaForge.');
    const safe=(file.name||'visual').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').slice(-120);
    const path=`loop/${Date.now()}-${crypto.randomUUID()}-${safe}`;
    const asset=await new Promise((resolve,reject)=>{
      const up=new tus.Upload(file,{
        endpoint:DIRECT_TUS,retryDelays:[0,3000,5000,10000,20000],headers:{authorization:`Bearer ${session.access_token}`,apikey:SB_KEY,'x-upsert':'true'},uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,chunkSize:6*1024*1024,
        metadata:{bucketName:BUCKET,objectName:path,contentType:file.type||'application/octet-stream',cacheControl:'3600'},
        onError:error=>{
          const raw=String(error?.message||error||'Erro desconhecido no Storage');
          if(/402|payment required/i.test(raw)){reject(platformRestriction());return;}
          const msg=file.size>FREE_PLAN_LIMIT?`O Storage recusou ${file.name} (${fmtBytes(file.size)}). O projeto está no plano Free, com limite global de 50 MB por arquivo. O uploader já usa TUS; após aumentar a cota/limite do Storage, o mesmo fluxo aceita vídeos longos normalmente. Detalhe: ${raw}`:raw;
          reject(new Error(msg));
        },
        onProgress:(sent,total)=>{const pct=total?Math.round(sent/total*100):0;if(bar)bar.style.width=`${pct}%`;setStatus(status,`${file.name} · ${fmtBytes(file.size)} · enviando ${pct}%`);},
        onSuccess:()=>resolve(path),
      });
      up.findPreviousUploads().then(prev=>{if(prev.length)up.resumeFromPreviousUpload(prev[0]);up.start();}).catch(reject);
    });
    const registered=await fn('office-music-control',{action:'register_asset',asset_type:'loop',storage_path:asset,title:file.name,mime_type:file.type||null,size_bytes:file.size,set_default:true,metadata:{live_visual:true,loop_forever:true,source:'live_upload'}});
    return registered.asset;
  }

  function selectedTrackIds(root){
    const checked=[...root.querySelectorAll('.pick:checked')].map(x=>String(x.value));
    try{
      const ordered=JSON.parse(root.dataset.collectionTrackIds||'[]').map(String);
      if(ordered.length===checked.length&&ordered.every(id=>checked.includes(id)))return ordered;
    }catch(_){}
    return checked;
  }
  function updateCount(root){const c=root.querySelectorAll('.pick:checked').length,total=root.querySelectorAll('.pick').length;const el=root.querySelector('#selectedCount');if(el)el.textContent=`${c} selecionadas de ${total} disponíveis`;}
  function applyTrackIds(root,ids){const ordered=(ids||[]).map(String);const set=new Set(ordered);root.querySelectorAll('.pick').forEach(x=>x.checked=set.has(String(x.value)));root.dataset.collectionTrackIds=JSON.stringify(ordered);updateCount(root);}
  function clearOtherSelectors(root,keep){['#ytPlaylist','#playlist','#seriesPlaylist','#hourMix'].forEach(sel=>{if(sel!==keep){const el=root.querySelector(sel);if(el)el.value='';}});}

  async function injectCollections(root){
    if(root.querySelector('#seriesPlaylist')||root.querySelector('#hourMix'))return;
    const search=root.querySelector('#trackSearch');if(!search)return;
    try{
      const {tracks,jobs}=await catalog();
      if(!root.querySelector('#trackSearch')||root.querySelector('#seriesPlaylist'))return;
      const playable=tracks.filter(t=>trackUrl(t));
      const position=new Map(playable.map(t=>[String(t.id),Number(t.position||0)]));
      const series=new Map();
      for(const t of playable){
        const m=t.metadata||{},key=String(m.series_key||m.series_request_id||'').trim();if(!key)continue;
        const name=String(m.series_name||m.series_title||m.series_playlist||key).trim();if(!series.has(key))series.set(key,{name,ids:[]});series.get(key).ids.push(String(t.id));
      }
      for(const g of series.values())g.ids.sort((a,b)=>(position.get(a)||0)-(position.get(b)||0));
      const jobsById=new Map((jobs||[]).map(j=>[String(j.id),j])),mixMap=new Map();
      for(const t of playable){
        if(!t.job_id)continue;const id=String(t.job_id),j=jobsById.get(id);if(!j||String(j.status)!=='completed')continue;
        if(!mixMap.has(id))mixMap.set(id,{job:j,ids:[],seconds:0});const g=mixMap.get(id);g.ids.push(String(t.id));g.seconds+=Number(t.duration_seconds||0);
      }
      for(const g of mixMap.values())g.ids.sort((a,b)=>(position.get(a)||0)-(position.get(b)||0));
      const hourMixes=[...mixMap.entries()].filter(([,g])=>Number(g.job.requested_duration_minutes||0)>=55&&g.seconds>=3300);
      const holder=document.createElement('div');
      holder.innerHTML=`<div class="field"><label>SÉRIE / PLAYLIST GERADA</label><select id="seriesPlaylist" class="select"><option value="">Não selecionar por série</option>${[...series.entries()].map(([k,g])=>`<option value="${String(k).replace(/"/g,'&quot;')}">${g.name} · ${g.ids.length} músicas</option>`).join('')}</select><div class="tiny muted" style="margin-top:5px">Seleciona todas as faixas geradas dentro da mesma série/playlist.</div></div><div class="field"><label>MIXES / MÚSICAS DE 1 HORA</label><select id="hourMix" class="select"><option value="">Não usar mix de 1 hora</option>${hourMixes.map(([id,g])=>{const y=g.job.youtube_video_id?` · YouTube ${g.job.youtube_video_id}`:'';return `<option value="${id}">Mix de 1 hora · ${g.ids.length} faixas · ${fmtDate(g.job.created_at)}${y}</option>`}).join('')}</select><div class="tiny muted" style="margin-top:5px">Reproduz, na ordem original, todas as faixas do mix de 60 minutos e repete durante a live.</div></div>`;
      const searchField=search.closest('.field'),parent=searchField?.parentNode;while(holder.firstElementChild)parent?.insertBefore(holder.firstElementChild,searchField);
      const seriesSelect=root.querySelector('#seriesPlaylist'),hourSelect=root.querySelector('#hourMix');
      if(seriesSelect)seriesSelect.onchange=()=>{const g=series.get(String(seriesSelect.value));if(g){applyTrackIds(root,g.ids);clearOtherSelectors(root,'#seriesPlaylist');}};
      if(hourSelect)hourSelect.onchange=()=>{const g=mixMap.get(String(hourSelect.value));if(g){applyTrackIds(root,g.ids);clearOtherSelectors(root,'#hourMix');}};
      const saved=root.querySelector('#playlist'),yt=root.querySelector('#ytPlaylist');
      if(saved&&!saved.dataset.groupAware){saved.dataset.groupAware='1';const old=saved.onchange;saved.onchange=e=>{root.dataset.collectionTrackIds='';clearOtherSelectors(root,'#playlist');if(old)old.call(saved,e);};}
      if(yt&&!yt.dataset.groupAware){yt.dataset.groupAware='1';const old=yt.onchange;yt.onchange=e=>{root.dataset.collectionTrackIds='';clearOtherSelectors(root,'#ytPlaylist');if(old)old.call(yt,e);};}
      if(!root.dataset.manualPickAware){root.dataset.manualPickAware='1';root.addEventListener('change',e=>{if(e.target?.classList?.contains('pick'))root.dataset.collectionTrackIds='';});}
    }catch(e){
      if(root.querySelector('[data-groups-error]'))return;const note=document.createElement('div');note.dataset.groupsError='1';note.className='note';note.style.marginTop='10px';note.textContent='Não foi possível carregar séries e mixes de 1 hora: '+(e?.message||e);search.closest('.field')?.before(note);
    }
  }

  async function startLive(root,btn){
    const ids=selectedTrackIds(root);if(!ids.length){alert('Selecione pelo menos uma música, série/playlist ou mix de 1 hora.');return;}
    if(root.dataset.visualUploadState==='uploading'){alert('Aguarde o upload do visual terminar.');return;}
    const kick=!!document.querySelector('.tab.kick.on'),d=Number(root.querySelector('#duration')?.value||60);
    let title=(root.querySelector('#title')?.value||'Peter Lofi — Live').trim()||'Peter Lofi — Live',description=root.querySelector('#description')?.value||'';
    if(kick){title='[KICK] '+title;description='[platform:kick]\n'+description;}
    const visualId=root.querySelector('#visual')?.value||null;btn.disabled=true;btn.textContent='Abrindo live…';
    try{
      const started=await fn('office-music-queue-control',{action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title,description,thumbnail_asset_id:root.querySelector('#thumb')?.value||null,visual_asset_id:visualId,loop_asset_id:visualId});
      const sessionId=started?.session?.id;if(!sessionId)throw new Error('A sessão da live foi criada sem ID.');
      if(visualId&&String(started?.visual?.asset_id||'')!==String(visualId))throw new Error('O visual selecionado não foi vinculado à sessão. A live não foi iniciada com fallback silencioso.');
      alert(kick?'Live da Kick enviada para a fila com o visual selecionado.':'Live do YouTube enviada para a fila com o visual selecionado.');setTimeout(()=>document.getElementById('refresh')?.click(),800);
    }catch(e){alert('Falha ao iniciar: '+(e?.message||e));btn.disabled=false;btn.textContent=kick?'● Iniciar na Kick':'▶ Iniciar no YouTube';}
  }

  function bind(){
    const root=document.getElementById('content'),vf=root?.querySelector('#visualFile'),btn=root?.querySelector('#start'),select=root?.querySelector('#visual');if(!root||!vf||!btn||!select)return;
    injectCollections(root);
    const kick=!!document.querySelector('.tab.kick.on');
    const kickNote=[...root.querySelectorAll('.note')].find(n=>n.textContent?.startsWith('Kick:'));if(kickNote)kickNote.innerHTML='<b>Kick:</b> RTMPS em H.264 1080p / 60 FPS, CBR 8000 kbps, keyframe de 2 s e AAC. Imagem fica fixa; vídeo usa a duração completa e repete em loop.';
    if(kick){const ta=root.querySelector('#description'),label=ta?.closest('.field')?.querySelector('label');if(label)label.textContent='DESCRIÇÃO / NOTAS';if(ta&&!ta.nextElementSibling?.matches?.('[data-kick-desc-note]')){const n=document.createElement('div');n.dataset.kickDescNote='1';n.className='tiny muted';n.style.marginTop='5px';n.textContent='A descrição fica registrada no MediaForge. A API pública da Kick não oferece descrição por transmissão; o título pode ser sincronizado via OAuth channel:write.';ta.after(n);}}
    if(vf.dataset.liveVisualV3!=='1'){
      vf.dataset.liveVisualV3='1';const bar=root.querySelector('#visualProgress'),status=root.querySelector('#visualFileName'),helper=vf.previousElementSibling?.querySelector('small');if(helper)helper.textContent='O upload começa ao selecionar. O arquivo escolhido será exatamente o visual da transmissão: imagem fixa ou vídeo em loop.';
      vf.onchange=async()=>{
        const file=vf.files?.[0];if(!file)return;root.dataset.visualUploadState='uploading';btn.disabled=true;if(bar)bar.style.width='0%';setStatus(status,`${file.name} · ${fmtBytes(file.size)} · preparando upload…`);
        try{
          const asset=await uploadVisual(file,bar,status);if(!asset?.id)throw new Error('Upload concluído, mas o asset não foi registrado.');
          let option=[...select.options].find(o=>o.value===String(asset.id));if(!option){option=document.createElement('option');option.value=asset.id;option.textContent=`${asset.title||file.name} · enviado agora`;select.appendChild(option);}
          select.value=String(asset.id);root.dataset.visualUploadState='ready';root.dataset.uploadedVisualId=String(asset.id);setStatus(status,`✓ ${file.name} · ${fmtBytes(file.size)} · upload concluído e selecionado como visual desta live`,'ok');vf.value='';
        }catch(e){root.dataset.visualUploadState='error';if(bar)bar.style.width='0%';setStatus(status,`Falha no upload: ${e?.message||e}`,'error');vf.value='';}finally{btn.disabled=false;}
      };
    }
    btn.onclick=e=>{e.preventDefault();e.stopPropagation();startLive(root,btn);};
  }

  const observer=new MutationObserver(bind);observer.observe(document.documentElement,{childList:true,subtree:true});bind();
})();
