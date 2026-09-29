(()=>{
  const href='./office-music.html';
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  let officeClient=null;
  let loadingProductions=false;
  let lastProductionLoad=0;

  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const fmt=d=>d?new Date(d).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const label=s=>({queued:'Na fila',generating:'Gerando músicas',rendering:'Renderizando 4K',uploading:'Enviando ao YouTube',completed:'Concluído',failed:'Falhou'}[s]||s||'—');
  const tone=s=>s==='completed'?'p-success':s==='failed'?'p-danger':s==='queued'?'p-warning':'p-info';

  function getClient(){
    if(officeClient)return officeClient;
    if(!window.supabase?.createClient)return null;
    officeClient=window.supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    return officeClient;
  }

  function patchNav(){
    const nav=document.querySelector('.sidebar .nav');
    if(!nav||document.getElementById('officeMusicStandaloneNav'))return;
    const links=[...nav.querySelectorAll('a')];
    const anchor=document.createElement('a');
    anchor.id='officeMusicStandaloneNav';
    anchor.href=href;
    anchor.innerHTML='<span class="ico">♫</span>The Office Music';
    const settings=links.find(a=>/configura/i.test(a.textContent||''));
    if(settings)nav.insertBefore(anchor,settings); else nav.appendChild(anchor);
  }

  function keepOfficeOutOfRegularVideoCreator(){
    if(!location.hash.startsWith('#/create'))return;
    document.querySelectorAll('button,.choice,[data-channel],[data-channel-id]').forEach(el=>{
      const text=(el.textContent||'').trim();
      if(/^The Office Music(?:\s|$)/i.test(text)||/The Office Music\s*Office Music\s*\/\s*Lounge House/i.test(text)){
        const card=el.closest('.choice,button')||el;
        card.style.display='none';
        card.setAttribute('aria-hidden','true');
      }
    });
  }

  async function patchProductions(){
    if(!location.hash.startsWith('#/productions'))return;
    const page=document.querySelector('.main .page');
    const head=page?.querySelector('.pagehead');
    if(!page||!head)return;

    let panel=document.getElementById('officeMusicProductionsPanel');
    if(!panel){
      panel=document.createElement('section');
      panel.id='officeMusicProductionsPanel';
      panel.style.marginBottom='18px';
      panel.innerHTML='<div class="card pad"><div class="row between wrap"><div><div class="tiny muted">CANAL DE MÚSICA · FLUXO SEPARADO</div><h3 style="margin:4px 0 2px">♫ The Office Music</h3><div class="small muted">Músicas, mixes de longa duração, render 4K e lives aparecem aqui sem entrar no fluxo dos canais de vídeo.</div></div><a class="btn primary" href="'+href+'">Abrir The Office Music</a></div><div id="officeMusicProdRows" class="grid" style="margin-top:14px"><div class="small muted">Carregando produções de música…</div></div></div>';
      head.insertAdjacentElement('afterend',panel);
    }

    const now=Date.now();
    if(loadingProductions||now-lastProductionLoad<15000)return;
    loadingProductions=true;
    try{
      const client=getClient();
      if(!client)throw new Error('Supabase indisponível');
      const {data,error}=await client.from('office_music_jobs').select('*').order('created_at',{ascending:false}).limit(12);
      if(error)throw error;
      lastProductionLoad=Date.now();
      const root=document.getElementById('officeMusicProdRows');
      if(!root)return;
      const jobs=data||[];
      if(!jobs.length){
        root.innerHTML='<div class="row between wrap"><div class="small muted">Nenhuma produção musical criada ainda.</div><a class="btn" href="'+href+'">Gerar primeira sessão</a></div>';
        return;
      }
      root.innerHTML=jobs.map(j=>{
        const pct=Math.max(0,Math.min(100,Number(j.progress)||0));
        const yt=j.youtube_url?'<a class="btn" target="_blank" rel="noopener" href="'+esc(j.youtube_url)+'">▶ YouTube</a>':'';
        const gh=j.github_run_url?'<a class="btn" target="_blank" rel="noopener" href="'+esc(j.github_run_url)+'">⌘ Execução</a>':'';
        return '<div style="border:1px solid var(--line);background:rgba(255,255,255,.018);border-radius:10px;padding:12px"><div class="row between wrap"><div><b class="small">'+esc(j.title||('Mix de '+j.requested_duration_minutes+' minutos'))+'</b><div class="tiny muted" style="margin-top:3px">'+fmt(j.created_at)+' · '+esc(j.requested_duration_minutes)+' min · '+esc(j.requested_tracks||'—')+' faixas</div></div><span class="pill '+tone(j.status)+'">'+esc(label(j.status))+'</span></div><div class="statusbar" style="margin-top:9px"><span style="width:'+pct+'%"></span></div>'+(j.error_message?'<div class="alert danger" style="margin-top:8px">'+esc(j.error_message)+'</div>':'')+((yt||gh)?'<div class="row wrap" style="margin-top:9px">'+yt+gh+'</div>':'')+'</div>';
      }).join('');
    }catch(e){
      const root=document.getElementById('officeMusicProdRows');
      if(root)root.innerHTML='<div class="small muted">Não foi possível carregar as produções de música agora. <a href="'+href+'" style="color:#fff;text-decoration:underline">Abra o console dedicado</a>.</div>';
      console.warn('Office Music productions:',e);
    }finally{loadingProductions=false;}
  }

  function patch(){
    patchNav();
    keepOfficeOutOfRegularVideoCreator();
    patchProductions();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patch);else patch();
  window.addEventListener('hashchange',()=>setTimeout(patch,0));
  new MutationObserver(()=>patch()).observe(document.documentElement,{childList:true,subtree:true});
})();
