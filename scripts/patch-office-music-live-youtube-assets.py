from pathlib import Path

JS_FILES = [Path('control-center/office-music.js'), Path('docs/control-center/office-music.js')]
HTML_FILES = [Path('control-center/office-music.html'), Path('docs/control-center/office-music.html')]


def require_replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'anchor not found: {label}')
    return text.replace(old, new, 1)


for path in JS_FILES:
    s = path.read_text(encoding='utf-8')

    s = require_replace(
        s,
        "  const BUCKET='office-music-assets';\n",
        "  const BUCKET='office-music-assets';\n  const YT_PLAYLIST_SNAPSHOT='https://raw.githubusercontent.com/thebusinessflowtv/theofficemusic/main/control/youtube-playlists.json';\n",
        f'{path}: youtube snapshot const',
    )
    s = require_replace(
        s,
        "  let state={jobs:[],tracks:[],lives:[],assets:[],masterRelease:null,tab:'generate'};\n",
        "  let state={jobs:[],tracks:[],lives:[],assets:[],youtubePlaylists:[],youtubePlaylistsUpdatedAt:null,masterRelease:null,tab:'generate'};\n",
        f'{path}: state',
    )

    invoke_anchor = """  async function invoke(body){
    const {data,error}=await client.functions.invoke('office-music-control',{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  }
"""
    invoke_new = invoke_anchor + """
  async function loadYoutubePlaylistSnapshot(){
    try{
      const r=await fetch(YT_PLAYLIST_SNAPSHOT+'?v='+Date.now(),{cache:'no-store'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const data=await r.json();
      return {playlists:Array.isArray(data?.playlists)?data.playlists:[],generated_at:data?.generated_at||null};
    }catch(_){return {playlists:[],generated_at:null}}
  }
"""
    s = require_replace(s, invoke_anchor, invoke_new, f'{path}: playlist loader')

    s = require_replace(
        s,
        "    const masterReleaseP=invoke({action:'health'}).catch(()=>null);\n",
        "    const masterReleaseP=invoke({action:'health'}).catch(()=>null);\n    const youtubePlaylistsP=loadYoutubePlaylistSnapshot();\n",
        f'{path}: loadData promise',
    )
    s = require_replace(
        s,
        "    state.jobs=jobsR.data||[]; state.tracks=tracksR.data||[]; state.lives=livesR.data||[]; state.assets=assetsR.data||[]; state.masterRelease=await masterReleaseP;\n",
        "    state.jobs=jobsR.data||[]; state.tracks=tracksR.data||[]; state.lives=livesR.data||[]; state.assets=assetsR.data||[]; state.masterRelease=await masterReleaseP; const yp=await youtubePlaylistsP; state.youtubePlaylists=yp.playlists||[]; state.youtubePlaylistsUpdatedAt=yp.generated_at||null;\n",
        f'{path}: loadData assignment',
    )

    marker = "  function tracksPicker(){\n"
    helpers = r'''  function youtubePlaylistTrackIds(playlistId){
    const p=state.youtubePlaylists.find(x=>x.id===playlistId); if(!p)return [];
    const jobsByVideo=new Map(state.jobs.filter(j=>j.youtube_video_id).map(j=>[String(j.youtube_video_id),j]));
    const out=[],seen=new Set();
    for(const item of (p.items||[])){
      const job=jobsByVideo.get(String(item.video_id||'')); if(!job)continue;
      const tracks=state.tracks.filter(t=>t.job_id===job.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
      for(const t of tracks)if(!seen.has(t.id)&&urlOf(t)){seen.add(t.id);out.push(t.id)}
    }
    return out;
  }

  function youtubePlaylistStats(p){
    const jobsByVideo=new Map(state.jobs.filter(j=>j.youtube_video_id).map(j=>[String(j.youtube_video_id),j]));
    let matchedVideos=0,trackCount=0;
    for(const item of (p.items||[])){
      const job=jobsByVideo.get(String(item.video_id||'')); if(!job)continue;
      matchedVideos++;
      trackCount+=state.tracks.filter(t=>t.job_id===job.id&&urlOf(t)).length;
    }
    return {matchedVideos,trackCount};
  }

'''
    if marker not in s:
        raise SystemExit(f'anchor not found: {path}: track picker')
    s = s.replace(marker, helpers + marker, 1)

    start = s.index('  function renderLive(){\n')
    end = s.index('\n  function renderLibrary(){', start)
    render_live = r'''  function renderLive(){
    const root=document.getElementById('view-live'); if(!root)return;
    const thumbs=state.assets.filter(a=>a.asset_type==='thumbnail');
    const ytOptions=state.youtubePlaylists.map(p=>{const st=youtubePlaylistStats(p);return `<option value="${esc(p.id)}">${esc(p.title||'Playlist sem nome')} · ${Number(p.item_count||0)} vídeos · ${st.trackCount} faixas reproduzíveis</option>`}).join('');
    const ytUpdated=state.youtubePlaylistsUpdatedAt?fmt(state.youtubePlaylistsUpdatedAt):'ainda não sincronizado';
    root.innerHTML=`<div class="grid grid2">
      <div class="grid">
        <div class="card pad livehero"><div class="row"><span class="live-dot"></span><div class="label">YouTube Live</div></div><h2 style="font-size:18px;margin:11px 0 5px">Abrir uma live do The Office Music</h2><p class="small muted" style="line-height:1.6;margin:0 0 16px">Escolha uma playlist do próprio canal no YouTube ou monte uma seleção manual de músicas salvas. Defina duração e thumbnail; a transmissão começa automaticamente.</p>
          <div class="field"><label>Título da live</label><input id="liveTitle" class="input" maxlength="100" value="The Office Music — Live Office Lounge"></div>
          <div class="field"><label>Descrição da live</label><textarea id="liveDescription" class="input" maxlength="5000" rows="5" style="min-height:110px;resize:vertical;font:inherit" placeholder="Descreva a live, o estilo musical, o canal e inclua links ou chamadas relevantes."></textarea><div class="tiny muted" style="margin-top:5px">Enviada diretamente para a descrição da transmissão no YouTube.</div></div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div class="field"><label>Duração</label><select id="liveDuration" class="select"><option value="60">1 hora</option><option value="120">2 horas</option><option value="180">3 horas</option><option value="360">6 horas</option><option value="720">12 horas</option><option value="0">Contínua — até encerrar manualmente</option></select></div><div class="field"><label>Thumbnail</label><select id="liveThumb" class="select"><option value="">Thumbnail padrão</option>${thumbs.map(a=>`<option value="${esc(a.id)}" ${a.is_default?'selected':''}>${esc(a.title||'Thumbnail')}</option>`).join('')}</select></div></div>
          <div class="field"><div class="row between wrap"><label style="margin:0">Playlist do YouTube</label><button id="reloadYoutubePlaylists" class="btn" type="button">↻ Recarregar</button></div><select id="youtubePlaylist" class="select" style="margin-top:7px"><option value="">Seleção manual / playlist salva do MediaForge</option>${ytOptions}</select><div id="youtubePlaylistInfo" class="tiny muted" style="margin-top:6px">Sincronização automática com o canal a cada hora · último snapshot: ${esc(ytUpdated)}.</div></div>
          <div class="note" style="margin-bottom:12px">Ao escolher uma playlist do YouTube, a ordem dos vídeos da playlist vira a ordem das músicas da live. São reproduzidas as faixas-fonte salvas no MediaForge dos vídeos daquele playlist. Vídeos externos ou antigos sem arquivos-fonte salvos são ignorados.</div>
          <div class="row between" style="margin:8px 0"><div><b class="small">Seleção manual</b><div class="tiny muted">Usada quando nenhuma playlist do YouTube estiver selecionada.</div></div><div class="row"><button id="selectAll" class="btn">Selecionar tudo</button><button id="clearAll" class="btn">Limpar</button></div></div>
          <div class="list" style="max-height:420px;overflow:auto">${tracksPicker()}</div>
          <div class="note" style="margin-top:12px">Modo contínuo é encadeado automaticamente para contornar o limite dos runners hospedados. Pode haver uma reconexão curta a cada bloco longo; o botão Encerrar envia um sinal de parada e finaliza a transmissão no YouTube.</div>
          <button id="startLive" class="btn primary block" style="margin-top:14px;min-height:45px" ${state.tracks.length?'':'disabled'}>● Iniciar live</button>
        </div>
      </div>
      <div class="grid"><div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Lives</h3><button id="refreshLives" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">${liveSessionsHtml()}</div></div><div class="card pad"><h3 class="section-title">Configuração automática</h3><div class="small muted" style="line-height:1.7">RTMP criado pela YouTube Live Streaming API · playlist em loop · vídeo 1080p/30 para estabilidade · áudio AAC · início e encerramento automáticos · reconexão encadeada no modo contínuo.</div></div></div>
    </div>`;
    root.querySelector('#selectAll').onclick=()=>root.querySelectorAll('.liveTrack').forEach(x=>x.checked=true);
    root.querySelector('#clearAll').onclick=()=>root.querySelectorAll('.liveTrack').forEach(x=>x.checked=false);
    root.querySelector('#refreshLives').onclick=refresh;
    const ytSel=root.querySelector('#youtubePlaylist');
    const ytInfo=root.querySelector('#youtubePlaylistInfo');
    const updateYtInfo=()=>{
      if(!ytSel.value){ytInfo.textContent=`Seleção manual ativa · playlists do YouTube sincronizadas: ${state.youtubePlaylists.length} · snapshot: ${ytUpdated}.`;return}
      const p=state.youtubePlaylists.find(x=>x.id===ytSel.value),st=p?youtubePlaylistStats(p):{matchedVideos:0,trackCount:0};
      ytInfo.textContent=p?`${p.title}: ${st.matchedVideos}/${Number(p.item_count||0)} vídeos com fonte disponível · ${st.trackCount} faixas entrarão na live.`:'Playlist indisponível.';
    };
    ytSel.onchange=updateYtInfo; updateYtInfo();
    root.querySelector('#reloadYoutubePlaylists').onclick=async()=>{const b=root.querySelector('#reloadYoutubePlaylists');b.disabled=true;b.textContent='Recarregando…';const yp=await loadYoutubePlaylistSnapshot();state.youtubePlaylists=yp.playlists||[];state.youtubePlaylistsUpdatedAt=yp.generated_at||null;renderLive();toast('Playlists recarregadas',`${state.youtubePlaylists.length} playlists encontradas no snapshot do canal.`)};
    root.querySelectorAll('.stopLive').forEach(b=>b.onclick=async()=>{if(!confirm('Encerrar esta live agora?'))return;b.disabled=true;try{await invoke({action:'stop_live',session_id:b.dataset.id});toast('Encerramento solicitado','A transmissão será finalizada automaticamente.');await refresh()}catch(e){toast('Falha ao encerrar',e.message||String(e),'error');b.disabled=false}});
    root.querySelector('#startLive').onclick=async()=>{
      const playlistId=ytSel.value;
      const ids=playlistId?youtubePlaylistTrackIds(playlistId):[...root.querySelectorAll('.liveTrack:checked')].map(x=>x.value);
      if(!ids.length){toast(playlistId?'Playlist sem fontes reproduzíveis':'Selecione músicas',playlistId?'Nenhum vídeo dessa playlist possui faixas-fonte salvas no MediaForge.':'Escolha pelo menos uma faixa para a live.','error');return}
      const btn=root.querySelector('#startLive');btn.disabled=true;btn.textContent='Preparando transmissão…';
      try{const d=Number(root.querySelector('#liveDuration').value);await invoke({action:'start_live',track_ids:ids,duration_minutes:d===0?null:d,title:root.querySelector('#liveTitle').value,description:root.querySelector('#liveDescription').value,thumbnail_asset_id:root.querySelector('#liveThumb').value||null});toast('Live criada',playlistId?`${ids.length} faixas carregadas da playlist do YouTube.`:'A seleção manual foi enviada para a transmissão.');await refresh()}
      catch(e){toast('Falha ao iniciar live',e.message||String(e),'error');btn.disabled=false;btn.textContent='● Iniciar live'}
    };
  }
'''
    s = s[:start] + render_live + s[end:]

    start = s.index('  function assetsHtml(type){\n')
    end = s.index('\n  async function uploadAsset(', start)
    assets_block = r'''  function assetPublicUrl(a){
    try{return client.storage.from(BUCKET).getPublicUrl(a.storage_path).data?.publicUrl||''}catch(_){return ''}
  }

  function openAssetPreview(a){
    const url=assetPublicUrl(a); if(!url){toast('Preview indisponível','Não foi possível obter a URL pública deste asset.','error');return}
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:24px';
    const box=document.createElement('div'); box.style.cssText='width:min(1000px,96vw);max-height:92vh;background:#151517;border:1px solid #3b3b40;border-radius:16px;padding:14px;box-shadow:0 30px 100px #000';
    const head=document.createElement('div'); head.className='row between'; head.innerHTML=`<div><b class="small">${esc(a.title||a.storage_path)}</b><div class="tiny muted">${esc(a.mime_type||'')}</div></div><button class="btn" type="button">✕ Fechar</button>`;
    const media=(a.asset_type==='loop'||String(a.mime_type||'').startsWith('video/'))?document.createElement('video'):document.createElement('img');
    media.src=url; media.style.cssText='display:block;width:100%;max-height:78vh;object-fit:contain;margin-top:12px;border-radius:10px;background:#050506';
    if(media.tagName==='VIDEO'){media.controls=true;media.autoplay=false;media.muted=true}
    head.querySelector('button').onclick=()=>overlay.remove(); overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
    box.append(head,media); overlay.appendChild(box); document.body.appendChild(overlay);
  }

  function assetsHtml(type){
    const list=state.assets.filter(a=>a.asset_type===type); if(!list.length)return '<div class="empty">Nenhum asset cadastrado.</div>';
    return list.map(a=>`<div class="asset"><div class="row between wrap"><div><b class="small">${esc(a.title||a.storage_path)}</b><div class="tiny muted" style="margin-top:3px">${esc(a.mime_type||'')} ${a.size_bytes?'· '+(a.size_bytes/1024/1024).toFixed(1)+' MB':''}</div></div>${a.is_default?'<span class="pill green">Padrão</span>':'<button class="btn setDefault" data-id="'+esc(a.id)+'">Definir padrão</button>'}</div><div class="row wrap" style="margin-top:9px"><button class="btn previewAsset" data-id="${esc(a.id)}">◉ Pré-visualizar</button><button class="btn renameAsset" data-id="${esc(a.id)}">✎ Renomear</button><button class="btn danger deleteAsset" data-id="${esc(a.id)}">Excluir</button></div></div>`).join('');
  }
'''
    s = s[:start] + assets_block + s[end:]

    s = require_replace(
        s,
        "<p class=\"small muted\">A thumbnail selecionada é usada automaticamente nos vídeos e pode ser escolhida na live.</p>",
        "<p class=\"small muted\">A thumbnail selecionada é usada automaticamente nos vídeos e pode ser escolhida na live. Ao enviar uma nova imagem, o nome inicial do asset será exatamente o nome do arquivo.</p>",
        f'{path}: asset filename text',
    )

    old_handlers = """    wire('thumbFile','thumbnail','thumbProgress');
    root.querySelectorAll('.setDefault').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await invoke({action:'set_default_asset',asset_id:b.dataset.id});toast('Padrão atualizado');await refresh()}catch(e){toast('Falha',e.message||String(e),'error');b.disabled=false}});
    root.querySelectorAll('.deleteAsset').forEach(b=>b.onclick=async()=>{if(!confirm('Excluir este asset permanentemente?'))return;b.disabled=true;try{await invoke({action:'delete_asset',asset_id:b.dataset.id});toast('Asset excluído');await refresh()}catch(e){toast('Falha ao excluir',e.message||String(e),'error');b.disabled=false}});
"""
    new_handlers = """    wire('loopFile','loop','loopProgress');
    wire('thumbFile','thumbnail','thumbProgress');
    root.querySelectorAll('.setDefault').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await invoke({action:'set_default_asset',asset_id:b.dataset.id});toast('Padrão atualizado');await refresh()}catch(e){toast('Falha',e.message||String(e),'error');b.disabled=false}});
    root.querySelectorAll('.previewAsset').forEach(b=>b.onclick=()=>{const a=state.assets.find(x=>x.id===b.dataset.id);if(a)openAssetPreview(a)});
    root.querySelectorAll('.renameAsset').forEach(b=>b.onclick=async()=>{const a=state.assets.find(x=>x.id===b.dataset.id);if(!a)return;const title=(prompt('Novo nome do asset:',a.title||'')||'').trim();if(!title||title===a.title)return;b.disabled=true;try{const {error}=await client.rpc('rename_office_music_asset',{p_asset_id:a.id,p_title:title});if(error)throw error;toast('Asset renomeado',title);await refresh()}catch(e){toast('Falha ao renomear',e.message||String(e),'error');b.disabled=false}});
    root.querySelectorAll('.deleteAsset').forEach(b=>b.onclick=async()=>{if(!confirm('Excluir este asset permanentemente?'))return;b.disabled=true;try{await invoke({action:'delete_asset',asset_id:b.dataset.id});toast('Asset excluído');await refresh()}catch(e){toast('Falha ao excluir',e.message||String(e),'error');b.disabled=false}});
"""
    s = require_replace(s, old_handlers, new_handlers, f'{path}: asset handlers')

    path.write_text(s, encoding='utf-8')

for path in HTML_FILES:
    s=path.read_text(encoding='utf-8')
    s=s.replace('office-music.js?v=20260929-4','office-music.js?v=20260929-5')
    path.write_text(s, encoding='utf-8')

print('Office Music live YouTube playlists + asset management patch applied.')
