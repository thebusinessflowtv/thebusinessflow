(()=>{
  const CLIENT_KEY='mediaforge_spotify_client_id';
  const AUTH_KEY='mediaforge_spotify_auth';
  const VERIFIER_KEY='mediaforge_spotify_pkce_verifier';
  const STATE_KEY='mediaforge_spotify_oauth_state';
  const RESOLVED_KEY='mediaforge_spotify_allowed75_resolved_v1';
  const REDIRECT_URI='https://peterlofi.odsgn.com.br/spotify-callback.html';
  const SCOPES='playlist-modify-private playlist-modify-public user-read-private';
  const DATA_URL='./data/spotify-approved-75.json';

  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const getClientId=()=>localStorage.getItem(CLIENT_KEY)||'';
  const getAuth=()=>{try{return JSON.parse(localStorage.getItem(AUTH_KEY)||'null')}catch(_){return null}};
  const saveAuth=x=>localStorage.setItem(AUTH_KEY,JSON.stringify(x));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function base64url(bytes){
    let s='';for(const b of bytes)s+=String.fromCharCode(b);
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function randomVerifier(){
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const a=crypto.getRandomValues(new Uint8Array(64));
    return Array.from(a,b=>chars[b%chars.length]).join('');
  }
  async function challenge(verifier){
    const dig=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(dig));
  }

  async function beginAuth(){
    const input=document.getElementById('spotifyClientId');
    const clientId=String(input?.value||getClientId()).trim();
    if(!/^[A-Za-z0-9]{16,64}$/.test(clientId)){
      alert('Cole primeiro o Client ID do seu app do Spotify.');
      input?.focus();return;
    }
    localStorage.setItem(CLIENT_KEY,clientId);
    const verifier=randomVerifier(),state=base64url(crypto.getRandomValues(new Uint8Array(24)));
    localStorage.setItem(VERIFIER_KEY,verifier);
    localStorage.setItem(STATE_KEY,state);
    const params=new URLSearchParams({
      client_id:clientId,response_type:'code',redirect_uri:REDIRECT_URI,
      code_challenge_method:'S256',code_challenge:await challenge(verifier),
      state,scope:SCOPES
    });
    const authUrl='https://accounts.spotify.com/authorize?'+params.toString();
    try{
      if(window.top&&window.top!==window){window.top.location.href=authUrl;}
      else{window.location.href=authUrl;}
    }catch(_){window.location.href=authUrl;}
  }

  async function refreshToken(){
    const clientId=getClientId(),auth=getAuth();
    if(!clientId||!auth?.refresh_token)throw new Error('Spotify não conectado.');
    const res=await fetch('https://accounts.spotify.com/api/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',refresh_token:auth.refresh_token,client_id:clientId})
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      if(data?.error==='invalid_grant')localStorage.removeItem(AUTH_KEY);
      throw new Error(data?.error_description||data?.error||('Spotify token HTTP '+res.status));
    }
    const next={...auth,...data,refresh_token:data.refresh_token||auth.refresh_token,expires_at:Date.now()+Number(data.expires_in||3600)*1000};
    saveAuth(next);return next.access_token;
  }
  async function accessToken(){
    const auth=getAuth();
    if(!auth?.access_token)throw new Error('Spotify não conectado.');
    if(Number(auth.expires_at||0)>Date.now()+90000)return auth.access_token;
    return refreshToken();
  }
  async function spotify(path,opt={},retry=true){
    const t=await accessToken();
    const res=await fetch('https://api.spotify.com/v1'+path,{...opt,headers:{authorization:'Bearer '+t,'content-type':'application/json',...(opt.headers||{})}});
    if(res.status===401&&retry){await refreshToken();return spotify(path,opt,false);}
    if(res.status===429&&retry){const wait=Math.min(15,Number(res.headers.get('retry-after')||2));await sleep(wait*1000);return spotify(path,opt,false);}
    const ct=res.headers.get('content-type')||'';
    const data=ct.includes('json')?await res.json().catch(()=>({})):await res.text().catch(()=>'');
    if(!res.ok)throw new Error(data?.error?.message||data?.error_description||data?.error||('Spotify HTTP '+res.status));
    return data;
  }

  function norm(s){
    return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      .replace(/\b(feat(?:uring)?|ft)\.?\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  }
  function tokens(s){return new Set(norm(s).split(' ').filter(Boolean));}
  function dice(a,b){
    const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return 2*n/(A.size+B.size);
  }
  function versionWords(s){
    const n=norm(s),keys=['remix','radio','edit','extended','instrumental','acoustic','live','remaster','mix'];
    return new Set(keys.filter(k=>new RegExp('\\b'+k+'\\b').test(n)));
  }
  function versionCompatible(a,b){
    const A=versionWords(a),B=versionWords(b);
    if(!A.size&&!B.size)return true;
    for(const x of A)if(!B.has(x))return false;
    return true;
  }
  function artistScore(ref,item){
    const wanted=String(ref||'').split(/\s*(?:,|;|&|\bx\b)\s*/i).map(norm).filter(Boolean);
    const got=(item?.artists||[]).map(a=>norm(a.name)).filter(Boolean);
    let best=0;
    for(const a of wanted)for(const b of got)best=Math.max(best,a===b?1:(a.includes(b)||b.includes(a)?0.92:dice(a,b)));
    return best;
  }
  function candidateScore(ref,item){
    const ts=dice(ref.title,item.name),as=artistScore(ref.artists,item),vo=versionCompatible(ref.title,item.name);
    let score=ts*.72+as*.28;
    if(!vo)score-=.22;
    if(norm(ref.title)===norm(item.name))score+=.05;
    return {score,ts,as,vo};
  }

  async function searchTrack(ref){
    const primary=String(ref.artists||'').split(',')[0].trim();
    const queries=[
      'track:"'+ref.title.replace(/"/g,'')+'" artist:"'+primary.replace(/"/g,'')+'"',
      ref.title+' '+primary,
      ref.title
    ];
    const seen=new Map();
    for(const q of queries){
      const d=await spotify('/search?type=track&limit=10&q='+encodeURIComponent(q));
      for(const item of (d?.tracks?.items||[])){
        if(!item?.uri||seen.has(item.uri))continue;
        seen.set(item.uri,item);
      }
      const ranked=[...seen.values()].map(item=>({item,...candidateScore(ref,item)})).sort((a,b)=>b.score-a.score);
      if(ranked[0]&&ranked[0].score>=.82&&ranked[0].ts>=.74&&ranked[0].as>=.72&&ranked[0].vo)return ranked[0];
    }
    const ranked=[...seen.values()].map(item=>({item,...candidateScore(ref,item)})).sort((a,b)=>b.score-a.score);
    return ranked[0]||null;
  }

  async function resolveAllowed75(onProgress){
    const src=await fetch(DATA_URL+'?v='+Date.now(),{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Não foi possível carregar as 75 ALLOWED.');return r.json()});
    let cached=null;try{cached=JSON.parse(localStorage.getItem(RESOLVED_KEY)||'null')}catch(_){}
    if(cached?.source_scan_id===src.source_scan_id&&Array.isArray(cached.tracks)&&cached.tracks.length===src.track_count)return {src,...cached};

    const resolved=[],unresolved=[];
    for(let i=0;i<src.tracks.length;i++){
      const ref=src.tracks[i];
      onProgress?.(i,src.tracks.length,'Buscando '+ref.title+' — '+ref.artists);
      const best=await searchTrack(ref);
      if(best&&best.score>=.82&&best.ts>=.74&&best.as>=.72&&best.vo){
        resolved.push({
          position:ref.position,title:ref.title,artists:ref.artists,
          spotify_uri:best.item.uri,spotify_id:best.item.id,
          spotify_title:best.item.name,
          spotify_artists:(best.item.artists||[]).map(a=>a.name).join(', '),
          confidence:Number(best.score.toFixed(4))
        });
      }else{
        unresolved.push({position:ref.position,title:ref.title,artists:ref.artists,best:best?{
          spotify_title:best.item?.name,spotify_artists:(best.item?.artists||[]).map(a=>a.name).join(', '),
          confidence:Number(best.score.toFixed(4)),title_score:Number(best.ts.toFixed(4)),artist_score:Number(best.as.toFixed(4)),version_match:best.vo
        }:null});
      }
      await sleep(70);
    }
    const result={source_scan_id:src.source_scan_id,resolved_at:new Date().toISOString(),tracks:resolved,unresolved};
    localStorage.setItem(RESOLVED_KEY,JSON.stringify(result));
    return {src,...result};
  }

  async function createPlaylist(){
    const btn=document.getElementById('spotifyCreateAllowed'),status=document.getElementById('spotifyStatus');
    const old=btn?.textContent;
    try{
      if(btn){btn.disabled=true;btn.textContent='Resolvendo 75 faixas…';}
      const profile=await spotify('/me');
      const result=await resolveAllowed75((i,total,msg)=>{
        if(status)status.textContent=(i+1)+'/'+total+' · '+msg;
        if(btn)btn.textContent='Resolvendo '+(i+1)+'/75…';
      });
      if(result.unresolved.length){
        const names=result.unresolved.slice(0,10).map(x=>'• '+x.title+' — '+x.artists).join('\n');
        throw new Error('Resolvidas '+result.tracks.length+'/75. Não vou criar uma playlist incompleta. Pendentes:\n'+names+(result.unresolved.length>10?'\n…':'')); 
      }
      const name=String(document.getElementById('spotifyPlaylistName')?.value||result.src.name||'Peter Lofi — Twitch DJ Allowed ✅').trim();
      const isPublic=String(document.getElementById('spotifyVisibility')?.value||'private')==='public';
      if(btn)btn.textContent='Criando playlist…';
      const playlist=await spotify('/me/playlists',{method:'POST',body:JSON.stringify({
        name,public:isPublic,collaborative:false,
        description:result.src.description||'75 faixas confirmadas como ALLOWED no Twitch DJ Music Catalog.'
      })});
      const uris=result.tracks.map(x=>x.spotify_uri);
      for(let i=0;i<uris.length;i+=100){
        await spotify('/playlists/'+encodeURIComponent(playlist.id)+'/items',{method:'POST',body:JSON.stringify({uris:uris.slice(i,i+100)})});
      }
      localStorage.setItem('mediaforge_spotify_last_playlist',JSON.stringify({id:playlist.id,url:playlist.external_urls?.spotify||'',name,count:uris.length,created_at:new Date().toISOString()}));
      if(status)status.innerHTML='✓ Playlist criada com <b>'+uris.length+'/75</b> faixas para '+esc(profile.display_name||'sua conta')+'. '+(playlist.external_urls?.spotify?'<a href="'+esc(playlist.external_urls.spotify)+'" target="_blank" rel="noopener">Abrir no Spotify ↗</a>':'');
      if(btn)btn.textContent='✓ Playlist criada';
    }catch(e){
      if(status){status.textContent='Falha: '+e.message;status.style.color='#ff9ca6';}
      if(btn){btn.disabled=false;btn.textContent=old||'Criar playlist com 75 ALLOWED';}
    }
  }

  async function hydrate(){
    const status=document.getElementById('spotifyStatus'),connect=document.getElementById('spotifyConnect'),create=document.getElementById('spotifyCreateAllowed');
    if(!status)return;
    const clientId=getClientId(),auth=getAuth();
    const input=document.getElementById('spotifyClientId');if(input&&clientId)input.value=clientId;
    if(!clientId){status.textContent='Configure o Client ID do seu app Spotify para conectar.';if(create)create.disabled=true;return;}
    if(!auth?.access_token){status.textContent='Client ID salvo. Falta autorizar sua conta Spotify.';if(create)create.disabled=true;return;}
    try{
      const me=await spotify('/me');
      const a={...getAuth(),display_name:me.display_name||'',account_id:me.account_id||'',spotify_user_id:me.id||''};saveAuth(a);
      status.innerHTML='Conectado como <b>'+esc(me.display_name||'Spotify')+'</b>. As credenciais ficam somente neste navegador.';
      if(connect)connect.textContent='Reconectar Spotify';
      if(create)create.disabled=false;
    }catch(e){
      status.textContent='Spotify precisa ser reconectado: '+e.message;
      if(create)create.disabled=true;
    }
  }

  function card(){
    const a=getAuth(),cid=getClientId();
    return `<section class="card" style="margin-top:14px;border-color:#1db95455">
      <div class="row between wrap"><div><b>Spotify · Playlist dos ALLOWED</b><div class="tiny muted" style="margin-top:4px">Cria uma playlist na sua conta usando somente as 75 faixas confirmadas como ALLOWED no scan de hoje.</div></div><span class="pill ${a?.access_token?'live':'queued'}">${a?.access_token?'CONECTADO':'CONFIGURAR'}</span></div>
      <div class="grid" style="grid-template-columns:minmax(260px,1.4fr) minmax(220px,1fr);gap:10px;margin-top:12px">
        <div class="field" style="margin:0"><label>SPOTIFY CLIENT ID</label><input id="spotifyClientId" class="input" type="password" autocomplete="new-password" spellcheck="false" placeholder="Cole o Client ID do Spotify Developer" value="${esc(cid)}"><div class="tiny muted" style="margin-top:5px">Redirect URI: <code>${REDIRECT_URI}</code> · <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Abrir Spotify Developer ↗</a></div></div>
        <div class="field" style="margin:0"><label>VISIBILIDADE</label><select id="spotifyVisibility" class="select"><option value="private" selected>Privada</option><option value="public">Pública</option></select></div>
      </div>
      <div class="field"><label>NOME DA PLAYLIST</label><input id="spotifyPlaylistName" class="input" value="Peter Lofi — Twitch DJ Allowed ✅"></div>
      <div class="row wrap">
        <button id="spotifySaveClient" class="btn">Salvar Client ID</button>
        <button id="spotifyConnect" class="btn" style="border-color:#1db954">Conectar Spotify</button>
        <button id="spotifyCreateAllowed" class="btn primary" disabled>Criar playlist com 75 ALLOWED</button>
        ${a?.access_token?'<button id="spotifyDisconnect" class="btn danger">Desconectar</button>':''}
      </div>
      <div id="spotifyStatus" class="tiny muted" style="margin-top:10px">Verificando conexão…</div>
    </section>`;
  }

  function bind(){
    document.getElementById('spotifySaveClient')?.addEventListener('click',()=>{
      const v=String(document.getElementById('spotifyClientId')?.value||'').trim();
      if(!v){alert('Cole o Client ID do Spotify.');return;}
      localStorage.setItem(CLIENT_KEY,v);alert('Client ID salvo neste navegador.');hydrate();
    });
    document.getElementById('spotifyConnect')?.addEventListener('click',beginAuth);
    document.getElementById('spotifyCreateAllowed')?.addEventListener('click',createPlaylist);
    document.getElementById('spotifyDisconnect')?.addEventListener('click',()=>{
      localStorage.removeItem(AUTH_KEY);localStorage.removeItem(RESOLVED_KEY);location.reload();
    });
    hydrate();
  }

  window.MediaForgeSpotify={card,bind,beginAuth,redirectUri:REDIRECT_URI};
})();
