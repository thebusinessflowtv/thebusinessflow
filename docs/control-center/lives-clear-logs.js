(()=>{
  const STORAGE_KEY='mediaforge_hidden_live_logs_v1';

  function readHidden(){
    try{return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]').map(String));}
    catch(_){return new Set();}
  }

  function writeHidden(set){
    localStorage.setItem(STORAGE_KEY,JSON.stringify([...set]));
  }

  function getRecentGrid(){
    const refresh=document.getElementById('refreshSessions');
    const head=refresh?.closest('.row.between');
    return head?.nextElementSibling?.classList?.contains('grid')?head.nextElementSibling:null;
  }

  function applyHidden(){
    const hidden=readHidden();
    const cards=[...document.querySelectorAll('.livecard[data-live]')];
    let visible=0;
    for(const card of cards){
      const hide=hidden.has(String(card.dataset.live||''));
      card.style.display=hide?'none':'';
      if(!hide)visible++;
    }

    const grid=getRecentGrid();
    if(grid){
      let note=grid.querySelector('.cleared-logs-note');
      if(cards.length&&visible===0){
        if(!note){
          note=document.createElement('div');
          note.className='card cleared-logs-note';
          note.innerHTML='<span class="small muted">Logs limpos. Novas lives aparecerão normalmente aqui.</span>';
          grid.appendChild(note);
        }
      }else if(note){
        note.remove();
      }
    }

    const restore=document.getElementById('restoreLiveLogs');
    if(restore)restore.style.display=hidden.size?'inline-flex':'none';
  }

  function installButtons(){
    const refresh=document.getElementById('refreshSessions');
    if(!refresh||document.getElementById('clearLiveLogs'))return;

    const actions=document.createElement('div');
    actions.className='row';

    const clear=document.createElement('button');
    clear.id='clearLiveLogs';
    clear.className='btn danger';
    clear.type='button';
    clear.textContent='🗑 Limpar logs';
    clear.title='Limpa os registros exibidos em Lives recentes';

    const restore=document.createElement('button');
    restore.id='restoreLiveLogs';
    restore.className='btn';
    restore.type='button';
    restore.textContent='↶ Restaurar';
    restore.style.display='none';

    refresh.parentNode.insertBefore(actions,refresh);
    actions.appendChild(clear);
    actions.appendChild(restore);
    actions.appendChild(refresh);

    clear.onclick=()=>{
      const cards=[...document.querySelectorAll('.livecard[data-live]')];
      if(!cards.length){alert('Não há logs para limpar.');return;}
      if(!confirm('Limpar os registros atuais de Lives recentes? Isso remove apenas os logs da visualização e não encerra nenhuma transmissão.'))return;
      const hidden=readHidden();
      cards.forEach(card=>hidden.add(String(card.dataset.live||'')));
      writeHidden(hidden);
      applyHidden();
    };

    restore.onclick=()=>{
      localStorage.removeItem(STORAGE_KEY);
      applyHidden();
    };
  }

  function sync(){installButtons();applyHidden();}
  const target=document.getElementById('content');
  if(target)new MutationObserver(()=>queueMicrotask(sync)).observe(target,{childList:true,subtree:true});
  sync();
})();
