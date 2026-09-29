(()=>{
  const href='./office-music.html';
  function patch(){
    const nav=document.querySelector('.sidebar .nav');
    if(nav&&!document.getElementById('officeMusicStandaloneNav')){
      const links=[...nav.querySelectorAll('a')];
      const anchor=document.createElement('a');
      anchor.id='officeMusicStandaloneNav'; anchor.href=href; anchor.innerHTML='<span class="ico">♫</span>The Office Music';
      const auto=links.find(a=>/auto heal/i.test(a.textContent||''));
      if(auto)nav.insertBefore(anchor,auto); else nav.appendChild(anchor);
    }
    document.querySelectorAll('button,.choice,.channel-card,[data-channel],[data-channel-id]').forEach(el=>{
      const text=(el.textContent||'').trim();
      if(/^The Office Music(?:\s|$)/i.test(text)||/The Office Music\s*Office Music\s*\/\s*Lounge House/i.test(text)){
        const card=el.closest('.choice,.channel-card,button')||el;
        card.style.display='none'; card.setAttribute('aria-hidden','true');
      }
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patch);else patch();
  new MutationObserver(patch).observe(document.documentElement,{childList:true,subtree:true});
})();
