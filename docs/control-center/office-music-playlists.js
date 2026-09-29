(()=>{
  const SB_URL='https://fykwalznmcrjgnyveagy.supabase.co';
  const SB_KEY='sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  const db=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let channelId=null, playlists=[];
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const notify=(title,text='',error=false)=>{
    const root=document.getElementById('toasts'); if(!root)return;
    const el=document.createElement('div'); el.className='toast'+(error?' error':'');
    el.innerHTML=`<b>${esc(title)}</b><div class="muted">${esc(text)}</div>`; root.appendChild(el); setTimeout(()=>el.remove(),4500);
  };
  async function load(){
    const {data:{session}}=await db.auth.getSession(); if(!session)return;
    const c=await db.from('mfcc_channels').select('id').eq('slug','the-office-music').maybeSingle();
    if(c.error||!c.data)return; channelId=c.data.id;
    const p=await db.from('office_music_playlists').select('*').eq('channel_id',channelId).order('created_at',{ascending:false});
    if(!p.error)playlists=p.data||[];
    inject();
  }
  function selectedIds(){return [...document.querySelectorAll('#view-live .liveTrack:checked')].map(x=>x.value)}
  function apply(ids){const set=new Set(ids||[]);document.querySelectorAll('#view-live .liveTrack').forEach(x=>x.checked=set.has(x.value))}
  function inject(){
    const live=document.getElementById('view-live'); if(!live||live.classList.contains('hidden')||document.getElementById('officePlaylistTools'))return;
    const trackList=live.querySelector('.liveTrack')?.closest('.list'); if(!trackList)return;
    const wrap=document.createElement('div'); wrap.id='officePlaylistTools'; wrap.className='card pad'; wrap.style.margin='10px 0';
    wrap.innerHTML=`<div class="row between wrap"><div><b class="small">Playlists salvas</b><div class="tiny muted">Salve combinações de faixas e reutilize em novas lives.</div></div><span class="pill blue">${playlists.length} salvas</span></div><div class="grid" style="grid-template-columns:minmax(0,1fr) auto auto;gap:8px;margin-top:10px"><select id="savedPlaylist" class="select"><option value="">Seleção manual atual</option>${playlists.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${(p.track_ids||[]).length} faixas</option>`).join('')}</select><button id="savePlaylist" class="btn">＋ Salvar seleção</button><button id="deletePlaylist" class="btn danger" disabled>Excluir</button></div>`;
    trackList.parentNode.insertBefore(wrap,trackList);
    const sel=wrap.querySelector('#savedPlaylist'), del=wrap.querySelector('#deletePlaylist');
    sel.onchange=()=>{const p=playlists.find(x=>x.id===sel.value);del.disabled=!p;if(p)apply(p.track_ids||[])};
    wrap.querySelector('#savePlaylist').onclick=async()=>{
      const ids=selectedIds(); if(!ids.length){notify('Selecione músicas','Escolha pelo menos uma faixa antes de salvar.',true);return}
      const name=(prompt('Nome da playlist:','Office Live Mix')||'').trim(); if(!name)return;
      const {error}=await db.from('office_music_playlists').insert({channel_id:channelId,name,track_ids:ids});
      if(error){notify('Falha ao salvar playlist',error.message,true);return} notify('Playlist salva',`${name} · ${ids.length} faixas`);await reload();
    };
    del.onclick=async()=>{const id=sel.value;if(!id)return;if(!confirm('Excluir esta playlist salva?'))return;const {error}=await db.from('office_music_playlists').delete().eq('id',id);if(error){notify('Falha ao excluir',error.message,true);return}notify('Playlist excluída');await reload()};
  }
  async function reload(){document.getElementById('officePlaylistTools')?.remove();if(!channelId)return load();const p=await db.from('office_music_playlists').select('*').eq('channel_id',channelId).order('created_at',{ascending:false});if(!p.error)playlists=p.data||[];inject()}
  const obs=new MutationObserver(()=>inject());
  const start=()=>{const live=document.getElementById('view-live');if(live)obs.observe(live,{childList:true,subtree:true});load()};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
