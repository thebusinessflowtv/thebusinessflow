from pathlib import Path
import re

p = Path('docs/control-center/app.html')
text = p.read_text(encoding='utf-8')

CSS = r'''
    /* MediaForge Apple HIG / Liquid Glass v2 */
    :root{
      --bg:#F2F2F7;--panel:#FFFFFF;--panel2:#F2F2F7;--line:rgba(60,60,67,.18);--line2:rgba(60,60,67,.29);
      --txt:#000000;--muted:rgba(60,60,67,.60);--blue:#007AFF;--violet:#AF52DE;--green:#34C759;--amber:#FF9500;--red:#FF3B30;
      --apple-system-bg:#FFFFFF;--apple-secondary-bg:#F2F2F7;--apple-tertiary-bg:#FFFFFF;--apple-grouped-bg:#F2F2F7;--apple-secondary-grouped:#FFFFFF;
      --apple-label:#000000;--apple-secondary-label:rgba(60,60,67,.60);--apple-tertiary-label:rgba(60,60,67,.30);
      --apple-fill:rgba(120,120,128,.20);--apple-secondary-fill:rgba(120,120,128,.16);--apple-separator:rgba(60,60,67,.24);
      --apple-glass:rgba(248,248,248,.72);--apple-glass-strong:rgba(252,252,252,.84);--shadow:0 12px 36px rgba(0,0,0,.07);--r:22px;
      color-scheme:light dark;
    }
    @media(prefers-color-scheme:dark){:root{
      --bg:#000000;--panel:#1C1C1E;--panel2:#2C2C2E;--line:rgba(84,84,88,.46);--line2:rgba(84,84,88,.65);
      --txt:#FFFFFF;--muted:rgba(235,235,245,.60);--blue:#0A84FF;--violet:#BF5AF2;--green:#30D158;--amber:#FF9F0A;--red:#FF453A;
      --apple-system-bg:#000000;--apple-secondary-bg:#1C1C1E;--apple-tertiary-bg:#2C2C2E;--apple-grouped-bg:#000000;--apple-secondary-grouped:#1C1C1E;
      --apple-label:#FFFFFF;--apple-secondary-label:rgba(235,235,245,.60);--apple-tertiary-label:rgba(235,235,245,.30);
      --apple-fill:rgba(120,120,128,.36);--apple-secondary-fill:rgba(120,120,128,.32);--apple-separator:rgba(84,84,88,.65);
      --apple-glass:rgba(28,28,30,.70);--apple-glass-strong:rgba(44,44,46,.82);--shadow:0 18px 48px rgba(0,0,0,.28);
    }}
    html,body{width:100%;max-width:100%;overflow-x:hidden;background:var(--apple-grouped-bg)!important;color:var(--apple-label)!important}
    body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Arial,sans-serif!important;background-image:none!important;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
    body:before{display:none!important}.main{min-width:0;background:var(--apple-grouped-bg)}
    .sidebar,.topbar,.mobile-dock,.more-sheet,.player-window,.modal,.toast{-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%)}
    .sidebar{background:var(--apple-glass)!important;border-right:1px solid var(--apple-separator)!important;box-shadow:none!important}
    .topbar{background:var(--apple-glass)!important;border-bottom:1px solid var(--apple-separator)!important;box-shadow:none!important}
    .brandmark{background:var(--blue)!important;border-radius:12px!important;box-shadow:none!important;color:white!important}.brand strong{color:var(--apple-label)}.brand small,.crumb,.muted{color:var(--apple-secondary-label)!important}
    .nav a{color:var(--apple-secondary-label)!important;border-radius:12px!important}.nav a:hover{background:var(--apple-secondary-fill)!important;color:var(--apple-label)!important;transform:none!important}.nav a.active{background:var(--apple-fill)!important;color:var(--apple-label)!important;box-shadow:none!important}.nav svg{stroke:currentColor}
    .page{max-width:1280px!important;padding:32px 34px 56px!important}.pagehead h1{font-size:34px!important;line-height:1.08!important;font-weight:700!important;letter-spacing:-.035em!important}.pagehead p{color:var(--apple-secondary-label)!important;font-size:13px!important}
    .card{background:var(--apple-secondary-grouped)!important;border:0!important;border-radius:22px!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}.card:not(.player-window):not(.modal){outline:1px solid color-mix(in srgb,var(--apple-separator) 55%,transparent)}
    .kpi{border-radius:20px!important}.kpi .num{font-variant-numeric:tabular-nums}.channel-card{border-radius:24px!important}.metricbox,.latest{background:var(--apple-secondary-bg)!important;border:0!important;border-radius:15px!important}.metricbox small,.latest small{color:var(--apple-secondary-label)!important}
    .btn{background:var(--apple-secondary-fill)!important;color:var(--apple-label)!important;border:0!important;border-radius:999px!important;box-shadow:none!important;min-height:40px!important;font-weight:600!important}.btn:hover{background:var(--apple-fill)!important;transform:none!important}.btn:active{transform:scale(.97)!important}.btn.primary{background:var(--blue)!important;color:white!important;box-shadow:none!important}.btn.danger{color:var(--red)!important;background:color-mix(in srgb,var(--red) 10%,transparent)!important}.btn svg{width:16px;height:16px}
    .pill{border:0!important;background:var(--apple-secondary-fill)!important;color:var(--apple-secondary-label)!important}.p-success{color:var(--green)!important}.p-info{color:var(--blue)!important}.p-violet{color:var(--violet)!important}.p-warning{color:var(--amber)!important}.p-danger{color:var(--red)!important}
    .input,.textarea,.select{background:var(--apple-secondary-bg)!important;color:var(--apple-label)!important;border:1px solid transparent!important;border-radius:13px!important;box-shadow:none!important}.input:focus,.textarea:focus,.select:focus{border-color:var(--blue)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 14%,transparent)!important}label{color:var(--apple-secondary-label)!important;font-weight:500}
    .choice,.objective{background:var(--apple-secondary-bg)!important;border:1px solid transparent!important;color:var(--apple-label)!important}.choice{border-radius:18px!important}.choice:hover{background:var(--apple-fill)!important}.choice.on,.objective.on{background:color-mix(in srgb,var(--blue) 12%,var(--apple-secondary-bg))!important;border-color:color-mix(in srgb,var(--blue) 45%,transparent)!important;box-shadow:none!important}.stepnum{background:color-mix(in srgb,var(--blue) 13%,transparent)!important;color:var(--blue)!important}.toggle{background:var(--apple-fill)!important;border:0!important}.toggle.on{background:var(--green)!important}
    .statusbar{background:var(--apple-secondary-fill)!important}.statusbar>span{background:var(--blue)!important;box-shadow:none!important}.bigprogress.live .statusbar>span:after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),rgba(255,255,255,.92),rgba(255,255,255,.18),transparent)!important}
    .phase .dot{background:var(--apple-secondary-bg)!important;border:0!important}.phase.done .dot{background:color-mix(in srgb,var(--green) 14%,var(--apple-secondary-bg))!important;color:var(--green)!important}.phase.cur .dot{background:color-mix(in srgb,var(--blue) 14%,var(--apple-secondary-bg))!important;color:var(--blue)!important}.phase.fail .dot{background:color-mix(in srgb,var(--red) 14%,var(--apple-secondary-bg))!important;color:var(--red)!important}
    .table th{color:var(--apple-secondary-label)!important}.table th,.table td{border-bottom-color:var(--apple-separator)!important}.table tr:hover td{background:var(--apple-secondary-bg)!important}.userbox{background:var(--apple-secondary-fill)!important;border:0!important}.avatar{background:var(--blue)!important;color:#fff!important}
    .modalback,.player-overlay{background:rgba(0,0,0,.44)!important}.modal,.player-window,.toast{background:var(--apple-glass-strong)!important;border:1px solid var(--apple-separator)!important;color:var(--apple-label)!important;box-shadow:0 24px 80px rgba(0,0,0,.28)!important}.player-stage{border-radius:18px!important}.glass-icon{background:var(--apple-secondary-fill)!important;border:0!important}.watch-card{background:var(--apple-secondary-grouped)!important}.eyebrow{color:var(--apple-secondary-label)!important}
    .disclosure{overflow:hidden!important}.disclosure summary{list-style:none;display:flex;align-items:center;gap:12px;padding:16px 18px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}.disclosure summary::-webkit-details-marker{display:none}.disclosure .disclosure-title{min-width:0;flex:1}.disclosure .disclosure-title b{display:block;font-size:15px;font-weight:600;letter-spacing:-.01em}.disclosure .disclosure-title small{display:block;font-size:11px;color:var(--apple-secondary-label);margin-top:2px}.disclosure .disclosure-chevron{width:18px;height:18px;color:var(--apple-tertiary-label);transition:transform .22s ease}.disclosure[open] .disclosure-chevron{transform:rotate(90deg)}.disclosure-body{padding:0 18px 18px;border-top:1px solid var(--apple-separator)}.disclosure-body .timeline{margin-top:16px}
    .apple-section-title{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--apple-secondary-label);font-weight:600;margin:20px 4px 8px}.settings-list{overflow:hidden}.settings-row{display:flex;align-items:center;gap:14px;padding:14px 16px;min-height:58px;border-bottom:1px solid var(--apple-separator)}.settings-row:last-child{border-bottom:0}.settings-row .settings-copy{min-width:0;flex:1}.settings-row .settings-copy b{display:block;font-size:15px;font-weight:600}.settings-row .settings-copy small{display:block;color:var(--apple-secondary-label);font-size:11px;margin-top:3px}.health-dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 12%,transparent)}.health-dot.warn{background:var(--amber);box-shadow:0 0 0 4px color-mix(in srgb,var(--amber) 12%,transparent)}.health-dot.bad{background:var(--red);box-shadow:0 0 0 4px color-mix(in srgb,var(--red) 12%,transparent)}
    .mobile-dock{display:none}.more-sheet{display:none}.more-backdrop{display:none}
    @media(max-width:900px){
      .shell{display:block!important;min-height:100dvh!important}.sidebar{display:none!important}.main{width:100%!important;max-width:100vw!important;overflow-x:hidden!important}.mobile-top{display:none!important}
      .topbar{height:56px!important;padding:0 16px!important;padding-left:max(16px,env(safe-area-inset-left))!important;padding-right:max(16px,env(safe-area-inset-right))!important}.topbar>.btn.primary{display:none!important}.crumb{font-size:13px!important}.crumb>b{font-weight:600!important}
      .page{width:100%!important;max-width:100%!important;padding:22px 16px calc(108px + env(safe-area-inset-bottom))!important;padding-left:max(16px,env(safe-area-inset-left))!important;padding-right:max(16px,env(safe-area-inset-right))!important}.pagehead{display:block!important;margin-bottom:20px!important}.pagehead h1{font-size:34px!important;line-height:1.04!important}.pagehead p{margin-top:7px!important;max-width:100%!important}.pagehead .btn{display:flex!important;width:100%;margin-top:12px}
      .grid4{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}.grid2,.create-layout,.detailgrid{grid-template-columns:minmax(0,1fr)!important}.grid,.grid2{min-width:0!important}.card,.channel-card,.step,.summary,.detail-head,.tablewrap{min-width:0!important;max-width:100%!important}.channel-card{min-height:auto!important;padding:20px!important}.channel-card .grid2{grid-template-columns:repeat(2,minmax(0,1fr))!important}.channel-actions{display:grid!important;grid-template-columns:1fr 1fr!important}.sticky{position:static!important}.filters{grid-template-columns:1fr!important}.tablewrap{overflow-x:auto!important;-webkit-overflow-scrolling:touch!important}.table{min-width:760px!important}.stepper{display:flex!important;overflow-x:auto!important;padding-bottom:6px!important;scrollbar-width:none}.stepper::-webkit-scrollbar{display:none}.phase{min-width:72px!important}.bigprogress{gap:10px!important}.percent{font-size:23px!important}.detail-head>.row:first-child{align-items:flex-start!important}.detail-head>.row:first-child>div:last-child{width:100%;justify-content:flex-start!important}.detail-head h1{font-size:24px!important;overflow-wrap:anywhere}.objectives{gap:7px!important}#modeChoices{grid-template-columns:1fr!important}.summary{order:-1}.toastbox{left:12px!important;right:12px!important;top:12px!important}.toast{min-width:0!important;width:100%!important}.player-overlay{padding:0!important;align-items:end!important}.player-window{width:100%!important;border-radius:28px 28px 0 0!important;border-bottom:0!important;padding:12px 12px calc(12px + env(safe-area-inset-bottom))!important}.player-stage{border-radius:18px!important}.modalback{align-items:end!important;padding:0!important}.modal{width:100%!important;border-radius:28px 28px 0 0!important;border-bottom:0!important;padding:22px 20px calc(22px + env(safe-area-inset-bottom))!important}
      .mobile-dock{position:fixed;display:grid!important;grid-template-columns:repeat(5,1fr);z-index:800;left:10px;right:10px;bottom:max(8px,env(safe-area-inset-bottom));height:68px;padding:7px 8px;background:var(--apple-glass)!important;border:1px solid var(--apple-separator);border-radius:24px;box-shadow:0 12px 38px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(30px) saturate(190%);backdrop-filter:blur(30px) saturate(190%)}.mobile-dock a,.mobile-dock button{border:0;background:none;color:var(--apple-secondary-label);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font:inherit;font-size:9px;font-weight:500;padding:0}.mobile-dock a.active{color:var(--blue)}.mobile-dock svg{width:22px;height:22px;stroke-width:1.8}
      .more-backdrop{position:fixed;inset:0;z-index:890;background:rgba(0,0,0,.28)}.more-sheet{position:fixed;display:block;z-index:900;left:10px;right:10px;bottom:calc(84px + env(safe-area-inset-bottom));padding:8px;background:var(--apple-glass-strong);border:1px solid var(--apple-separator);border-radius:24px;box-shadow:0 18px 60px rgba(0,0,0,.26);-webkit-backdrop-filter:blur(30px) saturate(190%);backdrop-filter:blur(30px) saturate(190%)}.more-sheet a,.more-sheet button{display:flex;width:100%;align-items:center;gap:12px;border:0;background:none;color:var(--apple-label);padding:13px 14px;border-radius:15px;font:inherit;font-size:15px;text-align:left}.more-sheet a:active,.more-sheet button:active{background:var(--apple-secondary-fill)}.more-sheet svg{width:20px;height:20px;color:var(--blue)}
    }
    @media(max-width:430px){.grid4{grid-template-columns:repeat(2,minmax(0,1fr))!important}.kpi{padding:15px!important}.kpi .num{font-size:30px!important}.channel-card .grid2{grid-template-columns:1fr 1fr!important}.channel-actions{grid-template-columns:1fr!important}.settings-row{padding:13px 14px}.topbar{padding-left:14px!important;padding-right:14px!important}.page{padding-left:14px!important;padding-right:14px!important}.detail-head{padding:20px!important}}
    @media(max-width:350px){.grid4{grid-template-columns:1fr!important}.mobile-dock{left:6px;right:6px}.mobile-dock a,.mobile-dock button{font-size:8px}}
'''

if 'MediaForge Apple HIG / Liquid Glass v2' not in text:
    text = text.replace('</style>', CSS + '\n  </style>', 1)

# Replace title mapping with Auto Heal support.
text = re.sub(
    r"  function titleFor\(path\)\{.*?\}\n  function shell",
    "  function titleFor(path){if(path==='/')return'Dashboard';if(path==='/create')return'Criar vídeo';if(path==='/ideas'||path.startsWith('/ideas/'))return'Ideias';if(path==='/productions')return'Produções';if(path.startsWith('/production/'))return'Detalhe da produção';if(path==='/channels')return'Canais';if(path==='/autoheal')return'Auto Heal';if(path==='/settings')return'Configurações';return'MediaForge'}\n  function shell",
    text, count=1, flags=re.S)

SHELL = r'''  function shell(content,path){
    const email=state.session&&state.session.user&&state.session.user.email||'';
    const nav=[['/','layout-dashboard','Dashboard'],['/create','plus','Criar vídeo'],['/ideas','sparkles','Ideias'],['/productions','clapperboard','Produções'],['/channels','radio-tower','Canais'],['/autoheal','shield-check','Auto Heal'],['/settings','settings','Configurações']];
    const active=n=>(path===n[0]||(n[0]==='/productions'&&path.startsWith('/production/'))||(n[0]==='/ideas'&&path.startsWith('/ideas/')));
    const desktop='<aside class="sidebar"><div class="brand"><div class="brandmark">M</div><div><strong>MediaForge</strong><small>Control Center</small></div></div><nav class="nav">'+nav.map(n=>'<a href="#'+n[0]+'" class="'+(active(n)?'active':'')+'"><span class="ico"><i data-lucide="'+n[1]+'"></i></span>'+n[2]+'</a>').join('')+'</nav><div class="side-bottom"><div class="userbox"><div class="avatar">'+esc(email.slice(0,1))+'</div><div class="usertext"><b>'+esc(email)+'</b><small>Administrador</small></div><button class="btn" id="logout" style="padding:6px 9px;min-height:30px" title="Sair"><i data-lucide="log-out"></i></button></div></div></aside>';
    const primary=[nav[0],nav[1],nav[2],nav[3]];
    const dock='<nav class="mobile-dock">'+primary.map(n=>'<a href="#'+n[0]+'" class="'+(active(n)?'active':'')+'"><i data-lucide="'+n[1]+'"></i><span>'+n[2].replace('Criar vídeo','Criar')+'</span></a>').join('')+'<button id="mobileMore"><i data-lucide="ellipsis"></i><span>Mais</span></button></nav>';
    const more='<div class="more-backdrop hidden" id="moreBackdrop"></div><div class="more-sheet hidden" id="moreSheet"><a href="#/channels"><i data-lucide="radio-tower"></i>Canais</a><a href="#/autoheal"><i data-lucide="shield-check"></i>Auto Heal</a><a href="#/settings"><i data-lucide="settings"></i>Configurações</a><button id="mobileLogout"><i data-lucide="log-out"></i>Sair</button></div>';
    return'<div class="shell">'+desktop+'<main class="main"><header class="topbar"><span class="crumb">MediaForge / <b>'+esc(titleFor(path))+'</b></span><span class="spacer"></span>'+(path!=='/create'?'<a class="btn primary" href="#/create"><i data-lucide="plus"></i> Criar vídeo</a>':'')+'</header><div class="page">'+content+'</div></main>'+dock+more+'</div>'
  }'''
text = re.sub(r"  function shell\(content,path\)\{.*?\}\n  function pageHead", SHELL + "\n  function pageHead", text, count=1, flags=re.S)

ENHANCE = r'''
  function enhanceTimeline(){
    const cards=[...document.querySelectorAll('.detailgrid>.card.pad')];
    const card=cards.find(x=>x.querySelector('h3')?.textContent.trim()==='Linha do tempo');
    if(!card||card.dataset.disclosureReady)return;
    const h=card.querySelector('h3');if(h)h.remove();
    const body=document.createElement('div');body.className='disclosure-body';while(card.firstChild)body.appendChild(card.firstChild);
    const count=body.querySelectorAll('.event').length;
    const details=document.createElement('details');details.className='card disclosure';details.dataset.disclosureReady='1';
    details.innerHTML='<summary><span class="glass-icon"><i data-lucide="clock-3"></i></span><span class="disclosure-title"><b>Linha do tempo</b><small>'+count+' evento'+(count===1?'':'s')+' · toque para expandir</small></span><i class="disclosure-chevron" data-lucide="chevron-right"></i></summary>';
    details.appendChild(body);card.replaceWith(details);
    const id=(location.hash.match(/#\/production\/([^?]+)/)||[])[1]||'';const key='timeline:'+id;
    details.open=state.timelineDisclosureKey===key?!!state.timelineDisclosureOpen:false;
    details.addEventListener('toggle',()=>{state.timelineDisclosureKey=key;state.timelineDisclosureOpen=details.open});
  }
'''
if 'function enhanceTimeline()' not in text:
    text = text.replace('  function wireShell()', ENHANCE + '\n  function wireShell()', 1)

WIRE = r'''  function wireShell(){
    const logoutNow=async()=>{await sb.auth.signOut();state.session=null;renderLogin()};
    const lo=document.getElementById('logout');if(lo)lo.onclick=logoutNow;
    const mlo=document.getElementById('mobileLogout');if(mlo)mlo.onclick=logoutNow;
    const more=document.getElementById('mobileMore'),sheet=document.getElementById('moreSheet'),back=document.getElementById('moreBackdrop');
    const setMore=open=>{if(!sheet||!back)return;sheet.classList.toggle('hidden',!open);back.classList.toggle('hidden',!open)};
    if(more)more.onclick=()=>setMore(sheet?.classList.contains('hidden'));if(back)back.onclick=()=>setMore(false);
    enhanceTimeline();if(window.lucide)lucide.createIcons({attrs:{'stroke-width':1.8}})
  }'''
text = re.sub(r"  function wireShell\(\)\{.*?\}\n  async function dashboard", WIRE + "\n  async function dashboard", text, count=1, flags=re.S)

AUTOHEAL = r'''
  async function autohealPage(path){
    const [channels,sR,eR]=await Promise.all([loadChannels(),sb.from('mfcc_autoheal_settings').select('*'),sb.from('mfcc_autoheal_events').select('*, mfcc_channels(name), mfcc_productions(requested_topic,selected_topic)').order('created_at',{ascending:false}).limit(80)]);
    if(sR.error)throw sR.error;if(eR.error)throw eR.error;const settings=sR.data||[],events=eR.data||[];const enabled=settings.filter(x=>x.enabled).length;
    let html=pageHead('Auto Heal','Diagnóstico e recuperação automática da fábrica de vídeos.','<button class="btn primary" id="scanHeal"><i data-lucide="stethoscope"></i> Verificar agora</button>');
    html+='<div class="grid grid4" style="margin-bottom:22px">'+[['Protegidos',enabled,'p-success'],['Recuperados',events.filter(x=>x.status==='recovered').length,'p-success'],['Tentando',events.filter(x=>x.status==='retrying').length,'p-info'],['Atenção',events.filter(x=>x.status==='needs_attention').length,'p-danger']].map(k=>'<div class="card kpi"><div class="label">'+k[0]+'</div><div class="num '+k[2]+'">'+k[1]+'</div></div>').join('')+'</div>';
    html+='<div class="apple-section-title">Proteção automática</div><div class="card settings-list">'+channels.map(c=>{const s=settings.find(x=>x.channel_id===c.id)||{enabled:true,max_attempts:2};return'<div class="settings-row"><span class="health-dot '+(s.enabled?'':'warn')+'"></span><div class="settings-copy"><b>'+esc(c.name)+'</b><small>'+(s.enabled?'Recuperação automática ligada · até '+s.max_attempts+' tentativas':'Recuperação automática pausada')+'</small></div><button class="toggle '+(s.enabled?'on':'')+' autohealToggle" data-id="'+esc(s.id||'')+'" data-channel="'+esc(c.id)+'" aria-label="Ativar Auto Heal"></button></div>'}).join('')+'</div>';
    html+='<div class="apple-section-title">Atividade recente</div>'+(events.length?'<div class="card settings-list">'+events.map(e=>{const tone=e.status==='recovered'?'p-success':e.status==='needs_attention'?'p-danger':e.status==='retrying'?'p-info':'';const title=e.mfcc_productions?.selected_topic||e.mfcc_productions?.requested_topic||'Produção';return'<a class="settings-row" href="#/production/'+e.production_id+'"><span class="health-dot '+(e.status==='needs_attention'?'bad':e.status==='retrying'?'warn':'')+'"></span><div class="settings-copy"><b>'+esc(title)+'</b><small>'+esc(e.message||e.error_class||'Auto Heal')+' · '+fmt(e.created_at)+'</small></div><span class="pill '+tone+'">'+esc(e.status==='recovered'?'Recuperado':e.status==='retrying'?'Tentando':e.status==='needs_attention'?'Atenção':'Detectado')+'</span><i data-lucide="chevron-right" style="width:17px"></i></a>'}).join('')+'</div>':empty('Nenhuma correção ainda','O Auto Heal registrará aqui diagnósticos, tentativas e recuperações.',''));
    app.innerHTML=shell(html,path);wireShell();
    document.querySelectorAll('.autohealToggle').forEach(b=>b.onclick=async()=>{const id=b.dataset.id;if(!id)return;const next=!b.classList.contains('on');b.disabled=true;const r=await sb.from('mfcc_autoheal_settings').update({enabled:next}).eq('id',id);if(r.error)toast('Não foi possível alterar',errMsg(r.error),'error');else{toast(next?'Auto Heal ativado':'Auto Heal pausado','','success');await autohealPage(path)}});
    const scan=document.getElementById('scanHeal');if(scan)scan.onclick=async()=>{scan.disabled=true;scan.textContent='Verificando…';try{const r=await invoke('mfcc-autoheal',{action:'scan'});toast('Verificação concluída',(r.scanned||0)+' produção(ões) analisada(s).','success');await autohealPage(path)}catch(e){toast('Falha no Auto Heal',errMsg(e),'error');scan.disabled=false;scan.textContent='Verificar agora'}}
  }
'''
if 'async function autohealPage(path)' not in text:
    text = text.replace('  async function settingsPage(path)', AUTOHEAL + '\n  async function settingsPage(path)', 1)

# Add Auto Heal route.
text = text.replace("else if(path==='/channels')await channelsPage(path);else if(path==='/settings')", "else if(path==='/channels')await channelsPage(path);else if(path==='/autoheal')await autohealPage(path);else if(path==='/settings')", 1)

p.write_text(text, encoding='utf-8')
print('Apple HIG v2 + disclosure timeline + Auto Heal UI applied')
