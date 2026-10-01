(()=>{
  const TOKEN_KEY='mediaforge_token';
  const apiBase=()=>String(window.MEDIAFORGE_CONFIG?.API_URL||localStorage.getItem('mediaforge_api_url')||'').replace(/\/$/,'');
  const token=()=>localStorage.getItem(TOKEN_KEY)||'';

  async function clearLogs(force=false){
    const base=apiBase();
    if(!base)throw new Error('Backend Cloudflare ainda não foi configurado.');
    const res=await fetch(base+'/api/live-sessions',{
      method:'DELETE',
      headers:{authorization:`Bearer ${token()}`,'content-type':'application/json'},
      body:JSON.stringify({force})
    });
    let data={};
    try{data=await res.json();}catch(_){data={};}
    if(res.status===401){
      localStorage.removeItem(TOKEN_KEY);
      location.replace('./secure.html');
      throw new Error('Sessão expirada.');
    }
    if(res.status===409)return {...data,blocked:true};
    if(!res.ok)throw new Error(data?.message||data?.error||`HTTP ${res.status}`);
    return data;
  }

  function installButton(){
    const refresh=document.getElementById('refreshSessions');
    if(!refresh||document.getElementById('clearLiveLogs'))return;
    const actions=document.createElement('div');
    actions.className='row';
    const btn=document.createElement('button');
    btn.id='clearLiveLogs';
    btn.className='btn danger';
    btn.type='button';
    btn.textContent='🗑 Limpar logs';
    btn.title='Remove os registros de lives recentes do painel';
    refresh.parentNode.insertBefore(actions,refresh);
    actions.appendChild(btn);
    actions.appendChild(refresh);

    btn.onclick=async()=>{
      if(!confirm('Limpar todos os registros de lives recentes?'))return;
      const original=btn.textContent;
      btn.disabled=true;
      btn.textContent='Limpando…';
      try{
        let result=await clearLogs(false);
        if(result?.blocked){
          const count=Number(result.active_count||0);
          const ok=confirm(`Existem ${count} sessão(ões) ativa(s) ou na fila. Limpar os logs NÃO encerra transmissões; apenas remove os registros do painel. Deseja limpar mesmo assim?`);
          if(!ok)return;
          result=await clearLogs(true);
        }
        alert(`${Number(result?.deleted||0)} registro(s) removido(s) dos logs.`);
        document.getElementById('refreshSessions')?.click();
      }catch(e){
        alert('Falha ao limpar logs: '+(e?.message||e));
      }finally{
        const current=document.getElementById('clearLiveLogs');
        if(current){current.disabled=false;current.textContent=original;}
      }
    };
  }

  const target=document.getElementById('content');
  if(target)new MutationObserver(()=>queueMicrotask(installButton)).observe(target,{childList:true,subtree:true});
  installButton();
})();
