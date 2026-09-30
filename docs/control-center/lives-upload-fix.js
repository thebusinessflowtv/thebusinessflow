(()=>{
  const PROJECT_ID='fykwalznmcrjgnyveagy';
  const SB_URL=`https://${PROJECT_ID}.supabase.co`;
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const BUCKET='office-music-assets';
  const DIRECT_TUS=`https://${PROJECT_ID}.storage.supabase.co/storage/v1/upload/resumable`;
  const CURRENT_FREE_LIMIT=50*1024*1024;
  const client=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});

  const fmtBytes=n=>{
    const x=Number(n||0);
    if(x>=1024**3)return `${(x/1024**3).toFixed(2)} GB`;
    return `${(x/1024**2).toFixed(1)} MB`;
  };
  const fn=async(name,body)=>{
    const {data,error}=await client.functions.invoke(name,{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  };
  const setStatus=(el,msg,type='muted')=>{
    if(!el)return;
    el.textContent=msg;
    el.style.color=type==='error'?'#ff9ca6':type==='ok'?'#8ff2bb':'#9999a2';
  };

  async function uploadVisual(file,bar,status){
    if(!window.tus)throw new Error('O módulo de upload TUS não carregou. Atualize a página.');
    if(file.size>CURRENT_FREE_LIMIT){
      throw new Error(`O vídeo selecionado tem ${fmtBytes(file.size)}. O Storage deste projeto está no plano Free e o limite global atual é 50 MB por arquivo. A duração do vídeo pode ser qualquer uma; o bloqueio aqui é apenas o tamanho do arquivo.`);
    }
    const {data:{session}}=await client.auth.getSession();
    if(!session)throw new Error('Sessão expirada. Entre novamente no MediaForge.');
    const safe=(file.name||'visual').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').slice(-120);
    const path=`loop/${Date.now()}-${crypto.randomUUID()}-${safe}`;
    const asset=await new Promise((resolve,reject)=>{
      const up=new tus.Upload(file,{
        endpoint:DIRECT_TUS,
        retryDelays:[0,3000,5000,10000,20000],
        headers:{authorization:`Bearer ${session.access_token}`,apikey:SB_KEY,'x-upsert':'true'},
        uploadDataDuringCreation:true,
        removeFingerprintOnSuccess:true,
        chunkSize:6*1024*1024,
        metadata:{bucketName:BUCKET,objectName:path,contentType:file.type||'application/octet-stream',cacheControl:'3600'},
        onError:error=>reject(error),
        onProgress:(sent,total)=>{
          const pct=total?Math.round(sent/total*100):0;
          if(bar)bar.style.width=`${pct}%`;
          setStatus(status,`${file.name} · ${fmtBytes(file.size)} · enviando ${pct}%`);
        },
        onSuccess:()=>resolve(path),
      });
      up.findPreviousUploads().then(prev=>{
        if(prev.length)up.resumeFromPreviousUpload(prev[0]);
        up.start();
      }).catch(reject);
    });
    const registered=await fn('office-music-control',{
      action:'register_asset',asset_type:'loop',storage_path:asset,title:file.name,
      mime_type:file.type||null,size_bytes:file.size,set_default:true,
      metadata:{live_visual:true,loop_forever:true,source:'live_upload'}
    });
    return registered.asset;
  }

  function selectedTrackIds(root){
    return [...root.querySelectorAll('.pick:checked')].map(x=>x.value);
  }

  async function startLive(root,btn){
    const ids=selectedTrackIds(root);
    if(!ids.length){alert('Selecione pelo menos uma música.');return;}
    if(root.dataset.visualUploadState==='uploading'){alert('Aguarde o upload do visual terminar.');return;}
    const kick=!!document.querySelector('.tab.kick.on');
    const d=Number(root.querySelector('#duration')?.value||60);
    let title=(root.querySelector('#title')?.value||'Peter Lofi — Live').trim()||'Peter Lofi — Live';
    let description=root.querySelector('#description')?.value||'';
    if(kick){title='[KICK] '+title;description='[platform:kick]\n'+description;}
    const visualId=root.querySelector('#visual')?.value||null;
    btn.disabled=true;btn.textContent='Abrindo live…';
    try{
      const started=await fn('office-music-queue-control',{
        action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title,description,
        thumbnail_asset_id:root.querySelector('#thumb')?.value||null
      });
      const sessionId=started?.session?.id;
      if(!sessionId)throw new Error('A sessão da live foi criada sem ID.');
      if(visualId){
        btn.textContent='Vinculando visual…';
        await fn('office-music-live-visual',{session_id:sessionId,asset_id:visualId});
      }
      alert(kick?'Live da Kick enviada para a fila com o visual selecionado.':'Live do YouTube enviada para a fila com o visual selecionado.');
      setTimeout(()=>document.getElementById('refresh')?.click(),800);
    }catch(e){
      alert('Falha ao iniciar: '+(e?.message||e));
      btn.disabled=false;btn.textContent=kick?'● Iniciar na Kick':'▶ Iniciar no YouTube';
    }
  }

  function bind(){
    const root=document.getElementById('content');
    const vf=root?.querySelector('#visualFile');
    const btn=root?.querySelector('#start');
    const select=root?.querySelector('#visual');
    if(!root||!vf||!btn||!select||vf.dataset.liveVisualV2==='1')return;
    vf.dataset.liveVisualV2='1';
    const bar=root.querySelector('#visualProgress');
    const status=root.querySelector('#visualFileName');
    const drop=vf.previousElementSibling;
    const helper=drop?.querySelector('small');
    if(helper)helper.textContent='O upload começa ao selecionar. Imagens ficam fixas; vídeos repetem em loop durante toda a live.';

    vf.onchange=async()=>{
      const file=vf.files?.[0];
      if(!file)return;
      root.dataset.visualUploadState='uploading';
      btn.disabled=true;
      if(bar)bar.style.width='0%';
      setStatus(status,`${file.name} · ${fmtBytes(file.size)} · preparando upload…`);
      try{
        const asset=await uploadVisual(file,bar,status);
        if(!asset?.id)throw new Error('Upload concluído, mas o asset não foi registrado.');
        let option=[...select.options].find(o=>o.value===String(asset.id));
        if(!option){option=document.createElement('option');option.value=asset.id;option.textContent=`${asset.title||file.name} · enviado agora`;select.appendChild(option);}
        select.value=String(asset.id);
        root.dataset.visualUploadState='ready';
        root.dataset.uploadedVisualId=String(asset.id);
        setStatus(status,`✓ ${file.name} · ${fmtBytes(file.size)} · upload concluído e selecionado para a live`,'ok');
        vf.value='';
      }catch(e){
        root.dataset.visualUploadState='error';
        if(bar)bar.style.width='0%';
        setStatus(status,`Falha no upload: ${e?.message||e}`,'error');
        vf.value='';
      }finally{
        btn.disabled=false;
      }
    };

    btn.onclick=e=>{e.preventDefault();e.stopPropagation();startLive(root,btn);};
  }

  const observer=new MutationObserver(bind);
  observer.observe(document.documentElement,{childList:true,subtree:true});
  bind();
})();
