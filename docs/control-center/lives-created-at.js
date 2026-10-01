(()=>{
  const API=(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'').replace(/\/$/,'');
  const TOKEN=localStorage.getItem('mediaforge_token')||'';
  let catalog=null;
  let timer=null;

  function fmtCreated(value){
    if(!value)return '';
    const d=new Date(value);
    if(Number.isNaN(d.getTime()))return '';
    return new Intl.DateTimeFormat('pt-BR',{
      timeZone:'America/Sao_Paulo',
      day:'2-digit',month:'2-digit',year:'numeric',
      hour:'2-digit',minute:'2-digit',hour12:false
    }).format(d).replace(',',' às');
  }

  function explicitCreated(item){
    return item?.created_at||item?.completed_at||item?.generated_at||item?.published_at||item?.metadata?.created_at||item?.metadata?.completed_at||item?.metadata?.generated_at||'';
  }

  function inferredCreated(item,trackMap){
    const explicit=explicitCreated(item);
    if(explicit)return explicit;
    const dates=(item?.track_ids||[])
      .map(id=>trackMap.get(String(id)))
      .map(t=>explicitCreated(t))
      .filter(Boolean)
      .map(v=>new Date(v))
      .filter(d=>!Number.isNaN(d.getTime()));
    if(!dates.length)return '';
    dates.sort((a,b)=>b-a);
    return dates[0].toISOString();
  }

  function putDate(checkbox,value){
    if(!checkbox||!value)return;
    const label=checkbox.closest('label');
    if(!label)return;
    const holder=checkbox.nextElementSibling;
    if(!holder)return;
    let meta=holder.querySelector(':scope > .mediaforge-created-at');
    if(!meta){
      meta=document.createElement('span');
      meta.className='tiny muted mediaforge-created-at';
      meta.style.display='block';
      meta.style.marginTop='3px';
      meta.style.opacity='.82';
      holder.appendChild(meta);
    }
    meta.textContent=`Criada em ${fmtCreated(value)}`;
  }

  function annotate(){
    if(!catalog)return;
    const tracks=catalog.tracks||[];
    const trackMap=new Map(tracks.map(t=>[String(t.id),t]));
    const seriesMap=new Map((catalog.series||[]).map(x=>[String(x.id),x]));
    const mixMap=new Map((catalog.hour_mixes||[]).map(x=>[String(x.id),x]));

    document.querySelectorAll('.seriesPick').forEach(cb=>{
      const item=seriesMap.get(String(cb.value));
      putDate(cb,inferredCreated(item,trackMap));
    });
    document.querySelectorAll('.mixPick').forEach(cb=>{
      const item=mixMap.get(String(cb.value));
      putDate(cb,inferredCreated(item,trackMap));
    });
    document.querySelectorAll('.pick').forEach(cb=>{
      const item=trackMap.get(String(cb.value));
      putDate(cb,explicitCreated(item));
    });
  }

  function schedule(){clearTimeout(timer);timer=setTimeout(annotate,80);}

  async function loadCatalog(){
    if(!API||!TOKEN)return;
    try{
      const res=await fetch(API+'/api/catalog',{headers:{authorization:`Bearer ${TOKEN}`}});
      if(!res.ok)return;
      catalog=await res.json();
      annotate();
      const root=document.getElementById('content');
      if(root)new MutationObserver(schedule).observe(root,{childList:true,subtree:true});
    }catch(e){console.warn('MediaForge created-at:',e);}
  }

  loadCatalog();
})();
