(function(){
  'use strict';

  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const FACTORY_TOPICS='https://raw.githubusercontent.com/thebusinessflowtv/thebusinessflow/main/production/topics.json';
  const TERMINAL=new Set(['completed','uploaded_private','failed']);
  const POLL_MS=10000;
  const MAX_STATUS_CHECKS=8;
  let busy=false;
  let timer=null;

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const topicOf=p=>(p.selected_topic||p.requested_topic||'').trim();
  const currentPath=()=>location.hash.slice(1).split('?')[0]||'/';
  const shouldSync=()=>['/','/productions'].includes(currentPath());

  function client(){
    if(!window.supabase||!window.supabase.createClient)return null;
    if(window.__mfccReconcileClient)return window.__mfccReconcileClient;
    window.__mfccReconcileClient=window.supabase.createClient(SB_URL,SB_KEY,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
    });
    return window.__mfccReconcileClient;
  }

  async function fetchFactoryTopics(){
    const r=await fetch(FACTORY_TOPICS+'?t='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('factory topics '+r.status);
    const j=await r.json();
    return Array.isArray(j&&j.topics)?j.topics:[];
  }

  function desiredState(factory,row){
    const s=String(factory.status||'');
    if(s==='uploaded_private'){
      return {
        status:'uploaded_private',progress:100,
        youtube_url:factory.youtube_video_id?'https://www.youtube.com/watch?v='+factory.youtube_video_id:(row.youtube_url||null),
        error_message:null
      };
    }
    if(s==='completed'||s==='rendered')return {status:'completed',progress:100,error_message:null};
    if(s==='upload_pending')return {status:'upload_pending',progress:Math.max(Number(row.progress)||0,95),error_message:null};
    if(s==='queue_blocked')return {
      status:'failed',progress:Number(row.progress)||0,
      error_message:factory.queue_block_reason||'Produção bloqueada pela fila da fábrica.'
    };
    return null;
  }

  function differs(row,next){
    if(!next)return false;
    return Object.entries(next).some(([k,v])=>{
      const a=row[k]??null,b=v??null;
      return String(a)!==String(b);
    });
  }

  async function invokeStatus(sb,row){
    try{
      const r=await sb.functions.invoke('mfcc-status',{body:{production_id:row.id}});
      if(r.error)console.warn('[MFCC sync] mfcc-status',row.id,r.error.message||r.error);
    }catch(e){console.warn('[MFCC sync] mfcc-status',row.id,e)}
  }

  async function reconcile(){
    if(busy||!shouldSync())return;
    busy=true;
    try{
      const sb=client();
      if(!sb)return;
      const session=await sb.auth.getSession();
      if(!session.data||!session.data.session)return;

      let q=await sb.from('mfcc_productions')
        .select('id,requested_topic,selected_topic,status,progress,youtube_url,error_message,github_run_url,created_at')
        .order('created_at',{ascending:false})
        .limit(120);
      if(q.error)throw q.error;
      let rows=q.data||[];

      // First ask the existing backend synchronizer for recent active jobs.
      const active=rows.filter(r=>!TERMINAL.has(r.status)).slice(0,MAX_STATUS_CHECKS);
      for(let i=0;i<active.length;i+=2){
        await Promise.all(active.slice(i,i+2).map(r=>invokeStatus(sb,r)));
        if(i+2<active.length)await sleep(150);
      }

      // Then reconcile durable factory state. This catches runs/uploads started
      // outside the Control Center and old rows whose original GitHub run went stale.
      const topics=await fetchFactoryTopics();
      const byTitle=new Map(topics.map(t=>[String(t.topic||'').trim().toLowerCase(),t]));

      // Refetch after mfcc-status may have changed rows.
      q=await sb.from('mfcc_productions')
        .select('id,requested_topic,selected_topic,status,progress,youtube_url,error_message,github_run_url,created_at')
        .order('created_at',{ascending:false})
        .limit(120);
      if(q.error)throw q.error;
      rows=q.data||[];

      let changed=false;
      for(const row of rows){
        const name=topicOf(row).toLowerCase();
        if(!name)continue;
        const factory=byTitle.get(name);
        if(!factory)continue;
        const next=desiredState(factory,row);
        if(!differs(row,next))continue;
        const u=await sb.from('mfcc_productions').update(next).eq('id',row.id);
        if(u.error){
          console.warn('[MFCC sync] reconcile update denied',row.id,u.error.message||u.error);
          continue;
        }
        changed=true;
      }

      // Detect status/progress changes produced by mfcc-status as well.
      const after=await sb.from('mfcc_productions')
        .select('id,status,progress,youtube_url,error_message')
        .in('id',rows.map(r=>r.id));
      if(!after.error){
        const beforeMap=new Map(rows.map(r=>[r.id,r]));
        for(const r of (after.data||[])){
          const b=beforeMap.get(r.id);
          if(b&&(b.status!==r.status||Number(b.progress||0)!==Number(r.progress||0)||String(b.youtube_url||'')!==String(r.youtube_url||''))){changed=true;break}
        }
      }

      if(changed&&shouldSync()){
        const now=Date.now();
        const last=Number(sessionStorage.getItem('mfcc:last-reconcile-reload')||0);
        if(now-last>2500){
          sessionStorage.setItem('mfcc:last-reconcile-reload',String(now));
          location.reload();
        }
      }
    }catch(e){
      console.warn('[MFCC sync] reconciliation failed',e);
    }finally{busy=false}
  }

  function arm(){
    if(timer)clearInterval(timer);
    setTimeout(reconcile,700);
    timer=setInterval(reconcile,POLL_MS);
  }
  window.addEventListener('hashchange',arm);
  window.addEventListener('focus',reconcile);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)reconcile()});
  arm();
})();
