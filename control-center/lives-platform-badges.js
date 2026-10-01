(()=>{
  const css=document.createElement('style');
  css.textContent=`
    .mf-platform-icon{width:22px;height:22px;border-radius:6px;display:inline-grid;place-items:center;margin-right:8px;font-size:10px;font-weight:900;vertical-align:middle;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
    .mf-platform-icon.youtube{background:#ff0033;color:#fff}
    .mf-platform-icon.kick{background:#53fc18;color:#071205;font-size:11px}
    .mf-platform-label{display:inline-flex;align-items:center;gap:6px}
  `;
  document.head.appendChild(css);

  function makeIcon(platform){
    const el=document.createElement('span');
    el.className=`mf-platform-icon ${platform}`;
    el.setAttribute('aria-label',platform==='youtube'?'YouTube':'Kick');
    el.title=platform==='youtube'?'YouTube':'Kick';
    el.textContent=platform==='youtube'?'▶':'K';
    return el;
  }

  function decorateCard(card){
    if(card.dataset.platformDecorated==='1')return;
    const meta=[...card.querySelectorAll('.tiny.muted')].map(x=>x.textContent||'').find(t=>/^\s*(YouTube|Kick)\s*·/i.test(t));
    if(!meta)return;
    const platform=/^\s*YouTube/i.test(meta)?'youtube':'kick';
    const title=card.querySelector('.row.between b');
    if(!title)return;
    if(title.firstChild&&title.firstChild.nodeType===Node.TEXT_NODE){title.firstChild.nodeValue=title.firstChild.nodeValue.replace(/^\s*[▶●]\s*/, '');}
    title.prepend(makeIcon(platform));
    card.dataset.platformDecorated='1';
    card.dataset.platform=platform;
  }

  function decorateTabs(){
    document.querySelectorAll('.platform-tabs .tab').forEach(tab=>{
      if(tab.dataset.iconDecorated==='1')return;
      const platform=tab.dataset.platform==='youtube'?'youtube':'kick';
      const text=tab.textContent.replace(/^\s*[▶●]\s*/,'').trim();
      tab.textContent='';tab.append(makeIcon(platform),document.createTextNode(text));
      tab.style.display='inline-flex';tab.style.alignItems='center';
      tab.dataset.iconDecorated='1';
    });
  }

  function sync(){decorateTabs();document.querySelectorAll('.livecard[data-live]').forEach(decorateCard);}
  const target=document.getElementById('content');
  if(target)new MutationObserver(()=>queueMicrotask(sync)).observe(target,{childList:true,subtree:true});
  sync();
})();
