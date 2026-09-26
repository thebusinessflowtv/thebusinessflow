from pathlib import Path
import re

p = Path('docs/control-center/app.html')
text = p.read_text(encoding='utf-8')

# Runtime libraries: system UI icons + client-side artifact unpacking for the video player.
if 'jszip@3.10.1' not in text:
    text = text.replace(
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js"></script>',
        1,
    )

APPLE_CSS = r'''
    /* MediaForge Apple Glass Design System v1 */
    :root{
      --bg:#05070b;--panel:rgba(24,27,34,.58);--panel2:rgba(255,255,255,.055);
      --line:rgba(255,255,255,.105);--line2:rgba(255,255,255,.16);--txt:#f5f5f7;
      --muted:#a1a1aa;--blue:#0a84ff;--violet:#bf5af2;--green:#30d158;--amber:#ff9f0a;
      --red:#ff453a;--shadow:0 28px 80px rgba(0,0,0,.34);--r:26px;
      --glass:rgba(22,25,32,.58);--glass-strong:rgba(27,30,38,.76);--glass-soft:rgba(255,255,255,.055);
    }
    html{background:#05070b;color-scheme:dark}
    html,body{overscroll-behavior:none}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif;
      -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
      background:
        radial-gradient(1050px 680px at 84% -8%,rgba(10,132,255,.20),transparent 58%),
        radial-gradient(900px 620px at 20% 5%,rgba(191,90,242,.13),transparent 56%),
        linear-gradient(180deg,#080a10 0%,#05070b 58%,#080a0f 100%);
      background-attachment:fixed;
    }
    body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;background:linear-gradient(120deg,rgba(255,255,255,.018),transparent 34%,rgba(255,255,255,.012));}
    .shell{grid-template-columns:272px minmax(0,1fr)}
    .sidebar{
      padding:20px 16px;border-right:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg,rgba(20,23,29,.72),rgba(12,14,19,.58));
      -webkit-backdrop-filter:blur(38px) saturate(180%);backdrop-filter:blur(38px) saturate(180%);
      box-shadow:12px 0 50px rgba(0,0,0,.13);
    }
    .brand{padding:4px 8px 28px;gap:12px}.brand strong{font-size:15px;letter-spacing:-.012em}.brand small{font-size:11px;color:#8e8e93}
    .brandmark{width:42px;height:42px;border-radius:13px;background:linear-gradient(145deg,#44a6ff,#6d5dfc 58%,#b45df8);box-shadow:0 9px 28px rgba(10,132,255,.28),inset 0 1px rgba(255,255,255,.35);font-size:16px}
    .nav{gap:5px}.nav a{min-height:44px;border-radius:14px;padding:10px 12px;color:#a9a9b2;font-size:13px;font-weight:520;letter-spacing:-.008em;transition:background .18s ease,color .18s ease,transform .18s ease}.nav a:hover{background:rgba(255,255,255,.065);color:#fff;transform:translateY(-1px)}.nav a.active{background:rgba(255,255,255,.105);color:#fff;box-shadow:inset 0 1px rgba(255,255,255,.09),0 8px 28px rgba(0,0,0,.13)}.nav .ico{width:22px;height:22px;display:grid;place-items:center}.nav svg{width:18px;height:18px;stroke-width:1.8}
    .userbox{border-color:rgba(255,255,255,.08);background:rgba(255,255,255,.045);border-radius:18px;padding:10px;box-shadow:inset 0 1px rgba(255,255,255,.04)}.avatar{background:linear-gradient(145deg,rgba(10,132,255,.25),rgba(191,90,242,.20));color:#fff}.usertext b{font-size:11px;font-weight:560}.usertext small{font-size:10px}
    .topbar{height:70px;padding:0 32px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(8,10,15,.48);-webkit-backdrop-filter:blur(34px) saturate(180%);backdrop-filter:blur(34px) saturate(180%)}
    .crumb{font-size:12px;color:#8e8e93}.crumb b{color:#f5f5f7;font-weight:560}.page{max-width:1320px;padding:34px 36px 54px}.pagehead{margin-bottom:26px;align-items:center}.pagehead h1{font-size:32px;line-height:1.08;font-weight:680;letter-spacing:-.042em}.pagehead p{font-size:13px;margin-top:7px;color:#8e8e93;line-height:1.45}
    .card{background:linear-gradient(145deg,rgba(255,255,255,.075),rgba(255,255,255,.032));border:1px solid rgba(255,255,255,.105);border-radius:26px;box-shadow:inset 0 1px rgba(255,255,255,.08),0 20px 60px rgba(0,0,0,.20);-webkit-backdrop-filter:blur(28px) saturate(155%);backdrop-filter:blur(28px) saturate(155%)}
    .pad,.step{padding:22px}.grid{gap:16px}.grid2{gap:16px}.grid4{gap:14px}
    .kpi{padding:20px;border-radius:23px}.kpi .label{font-size:11px;letter-spacing:.02em}.kpi .num{font-size:36px;font-weight:660;letter-spacing:-.055em}
    .channel-card{padding:24px;min-height:292px}.channel-card h3{font-size:22px;letter-spacing:-.035em}.channel-card .niche{font-size:12px;line-height:1.5}.metricbox,.latest{border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.036);border-radius:17px;padding:14px}.latest{padding:14px}
    .btn{min-height:42px;border-radius:13px;border:1px solid rgba(255,255,255,.115);background:rgba(255,255,255,.075);color:#f5f5f7;padding:9px 15px;font-size:12px;font-weight:560;letter-spacing:-.006em;box-shadow:inset 0 1px rgba(255,255,255,.055);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);transition:transform .16s ease,background .16s ease,filter .16s ease,box-shadow .16s ease}.btn:hover{background:rgba(255,255,255,.12);transform:translateY(-1px)}.btn:active{transform:scale(.985)}.btn.primary{background:#0a84ff;border-color:rgba(255,255,255,.18);box-shadow:inset 0 1px rgba(255,255,255,.22),0 10px 26px rgba(10,132,255,.24)}.btn.primary:hover{background:#168cff;filter:none}.btn.danger{color:#ff6961;background:rgba(255,69,58,.055)}.btn svg{width:16px;height:16px;stroke-width:2}
    .pill{border-color:rgba(255,255,255,.10);background:rgba(255,255,255,.055);border-radius:999px;padding:5px 10px;font-size:10px;font-weight:560;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
    .input,.textarea,.select{background:rgba(255,255,255,.055);border-color:rgba(255,255,255,.11);border-radius:15px;padding:12px 14px;color:#f5f5f7;box-shadow:inset 0 1px rgba(255,255,255,.035)}.input:focus,.textarea:focus,.select:focus{border-color:rgba(10,132,255,.7);box-shadow:0 0 0 4px rgba(10,132,255,.13)}label{font-size:11px;color:#a8a8b0;margin-bottom:7px}
    .choice{border-color:rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:19px;padding:17px}.choice:hover{border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.06)}.choice.on{border-color:rgba(10,132,255,.65);background:rgba(10,132,255,.10);box-shadow:inset 0 0 0 1px rgba(10,132,255,.15),0 12px 34px rgba(10,132,255,.08)}.choice strong{font-size:13px}.choice small{font-size:11px;line-height:1.45}.stepnum{width:28px;height:28px;background:rgba(10,132,255,.14);color:#7fc0ff;font-size:11px}.objective{border-color:rgba(255,255,255,.10);background:rgba(255,255,255,.045);padding:9px 13px}.objective.on{background:rgba(10,132,255,.13);border-color:rgba(10,132,255,.52)}
    .toggle{width:46px;height:27px;border:0;background:rgba(255,255,255,.15);padding:3px}.toggle:after{width:21px;height:21px;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.3)}.toggle.on{background:#30d158}.toggle.on:after{transform:translateX(19px)}
    .detail-head{padding:26px}.detail-head h1{font-size:26px;letter-spacing:-.04em}.bigprogress{margin-top:24px}.bigprogress .statusbar{height:10px}.percent{font-size:27px;font-weight:650;letter-spacing:-.04em}.stepper{margin-top:26px;gap:8px}.phase .dot{width:31px;height:31px;border-color:rgba(255,255,255,.13);background:rgba(255,255,255,.035)}
    .statusbar{background:rgba(255,255,255,.08)}.statusbar>span{background:linear-gradient(90deg,#0a84ff,#5e5ce6 70%,#bf5af2);box-shadow:0 0 16px rgba(10,132,255,.22)}
    .tablewrap{border-radius:24px}.table th{padding:13px 14px;color:#8e8e93;border-bottom-color:rgba(255,255,255,.08)}.table td{padding:14px;border-bottom-color:rgba(255,255,255,.055)}.table tr:hover td{background:rgba(255,255,255,.03)}
    .filters{gap:10px;margin-bottom:14px}.suggestion{padding:21px}.suggestion h3{font-size:17px;letter-spacing:-.02em}.empty{padding:56px 24px}.empty .bigico{border-color:rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:18px}
    .modalback{background:rgba(0,0,0,.53);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}.modal{border-radius:26px;padding:24px;background:rgba(30,33,41,.80)}
    .toastbox{top:18px;right:18px}.toast{border-radius:17px;background:rgba(31,34,42,.80);-webkit-backdrop-filter:blur(28px) saturate(170%);backdrop-filter:blur(28px) saturate(170%);border-color:rgba(255,255,255,.11);box-shadow:0 18px 60px rgba(0,0,0,.32)}
    .loginwrap{background:radial-gradient(800px 480px at 50% 30%,rgba(10,132,255,.16),transparent 60%)}.login{padding:32px;border-radius:30px;width:min(420px,100%)}
    .mobile-dock{display:none}.glass-icon{width:38px;height:38px;border-radius:13px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.09);display:grid;place-items:center}.glass-icon svg{width:18px;height:18px}
    .watch-card{background:linear-gradient(145deg,rgba(10,132,255,.11),rgba(94,92,230,.07) 45%,rgba(255,255,255,.035));}.watch-card p{margin:10px 0 15px;line-height:1.48}.eyebrow{font-size:9px;letter-spacing:.11em;color:#8e8e93;margin-bottom:4px;font-weight:650}
    .player-overlay{position:fixed;inset:0;z-index:1600;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.67);-webkit-backdrop-filter:blur(30px) saturate(130%);backdrop-filter:blur(30px) saturate(130%)}
    .player-window{width:min(1080px,100%);border-radius:30px;padding:14px;background:rgba(22,25,31,.78);border:1px solid rgba(255,255,255,.13);box-shadow:0 40px 120px rgba(0,0,0,.55),inset 0 1px rgba(255,255,255,.09);-webkit-backdrop-filter:blur(38px) saturate(170%);backdrop-filter:blur(38px) saturate(170%)}
    .player-head{display:flex;align-items:center;gap:12px;padding:5px 5px 14px 8px}.player-head-text{min-width:0;flex:1}.player-head-text b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player-head-text span{display:block;color:#8e8e93;font-size:10px;margin-top:3px}.player-close{width:34px;height:34px;border-radius:50%;padding:0;min-height:34px}.player-stage{aspect-ratio:16/9;background:#000;border-radius:21px;overflow:hidden;display:grid;place-items:center;position:relative;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}.player-stage video{width:100%;height:100%;object-fit:contain;background:#000}.player-loading{text-align:center;padding:24px}.player-loading .loader{margin:0 auto 14px}.player-loading b{display:block;font-size:14px}.player-loading span{display:block;font-size:11px;color:#8e8e93;margin-top:5px}.player-download-track{height:5px;width:min(300px,62vw);border-radius:999px;background:rgba(255,255,255,.10);overflow:hidden;margin:15px auto 0}.player-download-track i{height:100%;width:0;display:block;border-radius:999px;background:#0a84ff;transition:width .2s ease}.player-error{padding:32px;text-align:center}.player-error b{font-size:15px}.player-error p{font-size:11px;color:#8e8e93;line-height:1.5;max-width:460px}
    @media(max-width:820px){
      .shell{display:block}.sidebar{display:none!important}.main{min-height:100vh}.topbar{height:62px;padding:0 17px;background:rgba(12,14,19,.61);border-bottom-color:rgba(255,255,255,.08)}.topbar .mobile-top{display:none!important}.topbar>.btn.primary{min-width:40px;padding:9px 11px}.topbar>.btn.primary span{display:none}.crumb{font-size:11px}.page{padding:20px 14px calc(104px + env(safe-area-inset-bottom));max-width:none}.pagehead{align-items:flex-start;margin-bottom:20px}.pagehead h1{font-size:30px}.pagehead p{font-size:12px}.pagehead>.btn{display:flex!important}.grid2{grid-template-columns:1fr}.grid4{grid-template-columns:repeat(2,minmax(0,1fr))}.card{border-radius:22px}.pad,.step{padding:18px}.channel-card{padding:19px;min-height:auto}.create-layout,.detailgrid{grid-template-columns:1fr}.sticky{position:static}.create-layout{gap:14px}#channelChoices,#modeChoices{grid-template-columns:1fr!important}.objectives{flex-wrap:nowrap;overflow:auto;padding-bottom:4px;scrollbar-width:none}.objectives::-webkit-scrollbar{display:none}.objective{flex:0 0 auto}.detail-head{padding:20px}.detail-head>.row:first-child{align-items:flex-start}.detail-head>.row:first-child>.row{width:100%;justify-content:flex-start;flex-wrap:wrap}.detail-head h1{font-size:22px;line-height:1.16}.bigprogress{gap:10px}.percent{font-size:23px}.stepper{display:flex;overflow:auto;gap:15px;padding:2px 0 7px;scrollbar-width:none}.stepper::-webkit-scrollbar{display:none}.phase{flex:0 0 60px}.filters{grid-template-columns:1fr}.channel-actions{flex-wrap:wrap}.channel-actions .btn{flex:1}.tablewrap{overflow:auto;-webkit-overflow-scrolling:touch}.table{min-width:760px}.toastbox{left:12px;right:12px;top:12px}.toast{min-width:0;width:100%;max-width:none}.player-overlay{padding:10px}.player-window{padding:9px;border-radius:25px}.player-stage{border-radius:18px}.player-head{padding:5px 4px 11px}.mobile-dock{position:fixed;z-index:80;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));height:72px;display:grid;grid-template-columns:repeat(6,1fr);align-items:stretch;padding:7px 6px;border-radius:24px;background:rgba(28,31,38,.66);border:1px solid rgba(255,255,255,.13);box-shadow:0 18px 60px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.09);-webkit-backdrop-filter:blur(34px) saturate(180%);backdrop-filter:blur(34px) saturate(180%)}.mobile-dock a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#8e8e93;border-radius:16px;font-size:8.5px;font-weight:560;min-width:0;transition:.16s ease}.mobile-dock a svg{width:19px;height:19px;stroke-width:1.9}.mobile-dock a.active{color:#fff;background:rgba(255,255,255,.09)}.mobile-dock a.create-tab{color:#60adff}.mobile-dock a.create-tab.active{background:rgba(10,132,255,.15);color:#7fc0ff}
    }
    @media(max-width:520px){.grid4{grid-template-columns:1fr 1fr}.kpi{padding:17px}.kpi .num{font-size:30px}.page{padding-left:12px;padding-right:12px}.mobile-dock{left:7px;right:7px}.mobile-dock a{font-size:8px}.detail-head .btn{padding:8px 10px}.detail-head .pill{padding:5px 8px}.loginwrap{padding:14px}.login{padding:24px}.player-overlay{align-items:end;padding:0}.player-window{width:100%;border-radius:28px 28px 0 0;padding:10px 10px calc(10px + env(safe-area-inset-bottom));border-bottom:0}.player-stage{border-radius:19px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.btn,.statusbar>span{transition:none!important}.bigprogress.live .statusbar>span:after{animation-duration:3s}}
'''

if 'MediaForge Apple Glass Design System v1' not in text:
    text = text.replace('  </style>', APPLE_CSS + '\n  </style>', 1)

# Replace shell with a desktop sidebar + iOS-style mobile dock, using lightweight outline icons.
shell_pattern = re.compile(r"  function shell\(content,path\)\{.*?\n  function pageHead", re.S)
new_shell = r'''  function shell(content,path){
    const email=state.session&&state.session.user&&state.session.user.email||'';
    const nav=[['/','layout-dashboard','Dashboard'],['/create','circle-plus','Criar'],['/ideas','sparkles','Ideias'],['/productions','clapperboard','Produções'],['/channels','radio-tower','Canais'],['/settings','settings-2','Ajustes']];
    const isActive=n=>(path===n[0]||(n[0]==='/productions'&&path.startsWith('/production/'))||(n[0]==='/ideas'&&path.startsWith('/ideas/')));
    const desktop=nav.map(n=>'<a href="#'+n[0]+'" class="'+(isActive(n)?'active':'')+'"><span class="ico"><i data-lucide="'+n[1]+'"></i></span><span>'+n[2]+'</span></a>').join('');
    const dock=nav.map(n=>'<a href="#'+n[0]+'" class="'+(n[0]==='/create'?'create-tab ':'')+(isActive(n)?'active':'')+'"><i data-lucide="'+n[1]+'"></i><span>'+n[2]+'</span></a>').join('');
    return '<div class="shell"><aside class="sidebar"><div class="brand"><div class="brandmark">M</div><div><strong>MediaForge</strong><small>Control Center</small></div></div><nav class="nav">'+desktop+'</nav><div class="side-bottom"><div class="userbox"><div class="avatar">'+esc(email.slice(0,1))+'</div><div class="usertext"><b>'+esc(email)+'</b><small>Administrador</small></div><button class="btn" id="logout" style="padding:6px 9px;min-height:32px" title="Sair"><i data-lucide="log-out"></i></button></div></div></aside><main class="main"><header class="topbar"><span class="crumb">MediaForge / <b>'+esc(titleFor(path))+'</b></span><span class="spacer"></span>'+(path!=='/create'?'<a class="btn primary" href="#/create"><i data-lucide="plus"></i><span>Criar vídeo</span></a>':'')+'</header><div class="page">'+content+'</div></main><nav class="mobile-dock">'+dock+'</nav></div>'
  }
  function pageHead'''
if shell_pattern.search(text):
    text = shell_pattern.sub(new_shell, text, count=1)
else:
    raise SystemExit('shell function anchor not found')

# Wire icons after every render.
wire_pattern = re.compile(r"  function wireShell\(\)\{.*?\n  async function dashboard", re.S)
new_wire = r'''  function wireShell(){
    const lo=document.getElementById('logout');if(lo)lo.onclick=async()=>{await sb.auth.signOut();state.session=null;renderLogin()};
    if(window.lucide){try{lucide.createIcons({attrs:{'stroke-width':1.8}})}catch(e){console.warn(e)}}
  }
  async function dashboard'''
if wire_pattern.search(text):
    text = wire_pattern.sub(new_wire, text, count=1)
else:
    raise SystemExit('wireShell anchor not found')

# Add a secure in-app player. The browser downloads the authenticated GitHub artifact ZIP
# through Supabase, extracts the MP4 locally and plays it without exposing GitHub credentials.
if 'async function openVideoPlayer(' not in text:
    player_js = r'''
  async function responseBlobWithProgress(res,onProgress){
    const total=Number(res.headers.get('content-length')||0);
    if(!res.body||!res.body.getReader){const b=await res.blob();onProgress&&onProgress(100);return b}
    const reader=res.body.getReader(),chunks=[];let received=0;
    while(true){const x=await reader.read();if(x.done)break;chunks.push(x.value);received+=x.value.length;if(total&&onProgress)onProgress(Math.min(99,Math.round(received/total*100)))}
    onProgress&&onProgress(100);return new Blob(chunks,{type:'application/zip'})
  }

  async function openVideoPlayer(id,title){
    clearPoll();
    const back=document.createElement('div');back.className='player-overlay';
    back.innerHTML='<div class="player-window"><div class="player-head"><div class="glass-icon"><i data-lucide="play"></i></div><div class="player-head-text"><b>'+esc(title||'Vídeo final')+'</b><span>Player do MediaForge · vídeo final</span></div><button class="btn player-close" id="playerClose" aria-label="Fechar"><i data-lucide="x"></i></button></div><div class="player-stage" id="playerStage"><div class="player-loading"><div class="loader"></div><b id="playerLoadTitle">Preparando vídeo…</b><span id="playerLoadText">Localizando o arquivo final.</span><div class="player-download-track"><i id="playerDownloadBar"></i></div></div></div></div>';
    document.body.appendChild(back);document.body.style.overflow='hidden';if(window.lucide)lucide.createIcons({attrs:{'stroke-width':1.8}});
    const stage=back.querySelector('#playerStage'),bar=back.querySelector('#playerDownloadBar'),lt=back.querySelector('#playerLoadTitle'),ls=back.querySelector('#playerLoadText');let objectUrl=null;
    const close=()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);back.remove();document.body.style.overflow='';if(location.hash.startsWith('#/production/'+id))route()};
    back.querySelector('#playerClose').onclick=close;back.onclick=e=>{if(e.target===back)close()};
    const escClose=e=>{if(e.key==='Escape'){document.removeEventListener('keydown',escClose);close()}};document.addEventListener('keydown',escClose);
    try{
      if(!window.JSZip)throw new Error('Biblioteca do player não carregou. Atualize a página e tente novamente.');
      const session=(await sb.auth.getSession()).data.session;if(!session)throw new Error('Sessão expirada. Entre novamente.');
      lt.textContent='Baixando vídeo…';ls.textContent='O arquivo é carregado de forma privada para este player.';
      const res=await fetch(SB_URL+'/functions/v1/mfcc-video-bundle',{method:'POST',headers:{'Authorization':'Bearer '+session.access_token,'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({production_id:id})});
      if(!res.ok){let m='Não foi possível carregar o vídeo.';try{const j=await res.json();m=j.message||j.error||m}catch(_){}throw new Error(m)}
      const zipBlob=await responseBlobWithProgress(res,p=>{bar.style.width=p+'%';ls.textContent='Baixando arquivo final · '+p+'%'});
      lt.textContent='Abrindo vídeo…';ls.textContent='Preparando o MP4 no navegador.';
      const zip=await JSZip.loadAsync(await zipBlob.arrayBuffer());
      const files=Object.values(zip.files).filter(f=>!f.dir&&/\.mp4$/i.test(f.name));
      if(!files.length)throw new Error('O pacote final não contém um arquivo MP4 reproduzível.');
      const preferred=files.find(f=>/(final|output|episode|video)/i.test(f.name))||files[0];
      const bytes=await preferred.async('uint8array');objectUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
      stage.innerHTML='<video controls playsinline preload="metadata" id="mfccVideo"></video>';const video=stage.querySelector('#mfccVideo');video.src=objectUrl;video.focus();video.play().catch(()=>{});
    }catch(e){stage.innerHTML='<div class="player-error"><b>Não foi possível abrir o player</b><p>'+esc(errMsg(e))+'</p><button class="btn" id="playerRetry"><i data-lucide="rotate-cw"></i> Tentar novamente</button></div>';if(window.lucide)lucide.createIcons({attrs:{'stroke-width':1.8}});stage.querySelector('#playerRetry').onclick=()=>{close();openVideoPlayer(id,title)}}
  }
'''
    text = text.replace('  async function productionDetail(path,id){', player_js + '\n  async function productionDetail(path,id){', 1)

# Add an explicit Watch card to every completed production.
watch_anchor = "if(done)right='<div class=\"card pad\"><h3 class=\"small\">Arquivos gerados</h3>"
if 'id="watchVideo"' not in text:
    if watch_anchor not in text:
        raise SystemExit('completed artifacts card anchor not found')
    watch_card = "if(done)right='<div class=\"card pad watch-card\"><div class=\"row between\"><div><div class=\"eyebrow\">PREVIEW</div><h3 class=\"small\">Assistir vídeo</h3></div><span class=\"glass-icon\"><i data-lucide=\"play\"></i></span></div><p class=\"small muted\">Reproduza o vídeo final diretamente no Control Center antes de baixar ou publicar.</p><button class=\"btn primary block\" id=\"watchVideo\"><i data-lucide=\"play\"></i> Reproduzir vídeo</button></div><div class=\"card pad\"><h3 class=\"small\">Arquivos gerados</h3>"
    text = text.replace(watch_anchor, watch_card, 1)

# Wire the player button in the production detail view.
handler_anchor = "app.innerHTML=shell(html,path);wireShell();document.getElementById('refreshStatus').onclick="
if "watchVideo.onclick=()=>openVideoPlayer" not in text:
    if handler_anchor not in text:
        raise SystemExit('production detail handler anchor not found')
    text = text.replace(handler_anchor, "app.innerHTML=shell(html,path);wireShell();const watchVideo=document.getElementById('watchVideo');if(watchVideo)watchVideo.onclick=()=>openVideoPlayer(id,topic(p));document.getElementById('refreshStatus').onclick=", 1)

p.write_text(text, encoding='utf-8')
print('Apple Glass UI, mobile dock and secure video player applied')
