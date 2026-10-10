(function(){
var API=(window.MEDIAFORGE_CONFIG&&window.MEDIAFORGE_CONFIG.API_URL||"").replace(/\/$/,"");
function token(){return localStorage.getItem("mediaforge_token")||""}
var el=document.getElementById("content"),assets=[];
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function fmt(d){try{return d?new Date(d).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}):"—"}catch(e){return d||"—"}}
function pct(v){return v==null?"—":Number(v).toFixed(1)+"%"}
function dur(s){s=Number(s||0);if(!s)return"—";var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+"d ":"")+h+"h "+m+"m"}
function bytes(n){n=Number(n||0);if(n>=1073741824)return(n/1073741824).toFixed(2)+" GB";if(n>=1048576)return(n/1048576).toFixed(1)+" MB";if(n>=1024)return(n/1024).toFixed(1)+" KB";return n+" B"}
function shortUrl(u){u=String(u||"");if(!u)return"não reportado";try{var x=new URL(u);var tail=x.pathname.split("/").filter(Boolean).slice(-1)[0]||"";return x.hostname+(tail?" · "+tail.slice(0,28):"")}catch(e){return u.slice(0,54)}}
async function api(path,opt){opt=opt||{};var headers=Object.assign({},opt.headers||{}, {authorization:"Bearer "+token()});if(opt.body&&!(opt.body instanceof Blob)&&!headers["content-type"])headers["content-type"]="application/json";var r=await fetch(API+path,Object.assign({},opt,{headers:headers,cache:"no-store"}));var data={};try{data=await r.json()}catch(e){}if(r.status===401){localStorage.removeItem("mediaforge_token");location.replace("./secure.html");throw new Error("Sessão expirada")}if(!r.ok)throw new Error(data.message||data.error||("HTTP "+r.status));return data}
var labels={"kick":"Kick Gaming","twitch":"Twitch Gaming","youtube-deep-house":"YouTube · Deep House","youtube-rainy":"YouTube · Rainy Lofi","youtube-gta-vi":"YouTube · GTA VI - Vice City","youtube-lofi-hip-hop":"YouTube · Lofi Hip Hop","youtube-ui-test":"YouTube · UI Test"};
var platformPriority=["kick","twitch","youtube-deep-house","youtube-rainy","youtube-gta-vi","youtube-lofi-hip-hop"];
function liveSlots(agent){
 var services=agent&&agent.services||{},received=agent&&(agent.reported_at||agent.stored_at)||"";
 var hb=Date.parse(received),now=Date.now();
 if(!Number.isFinite(hb)||Math.abs(now-hb)>75000)return [];
 return Object.keys(services).filter(function(slot){
   var s=services[slot]||{},stamp=Date.parse(s.updated_at||"");
   var pid=Number(s.encoder_pid||0);
   return String(s.status||"").toLowerCase()==="live"&&Number.isInteger(pid)&&pid>0&&
       Number.isFinite(stamp)&&stamp<=now+15000&&now-stamp<90000;
 }).sort(function(a,b){
   var ai=platformPriority.indexOf(a),bi=platformPriority.indexOf(b);
   return (ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b);
 });
}
function labelFor(slot,s){return labels[slot]||String(s&&s.title||slot).slice(0,72);}

function videos(){return assets.filter(function(a){return a.asset_type==="loop"&&String(a.mime_type||"").indexOf("video/")===0})}
function visualOptions(current){var list=videos();return '<option value="">Selecionar vídeo salvo…</option>'+list.map(function(a){var sel=String(a.public_url||"")===String(current||"")?" selected":"";return '<option value="'+esc(a.id)+'"'+sel+'>'+esc(a.title||"Vídeo")+' · '+esc(bytes(a.size_bytes))+'</option>'}).join("")}
function serviceCard(slot,s){s=s||{};var np=s.now_playing||{},st=String(s.status||"unknown"),loop=String(s.loop_url||"");return '<section class="card"><div class="row between wrap"><div><b>'+esc(labelFor(slot,s))+'</b><div class="tiny muted" style="margin-top:4px">'+esc(s.session_id||"sem sessão")+' · OVH</div></div><span class="pill '+esc(st)+'">'+esc(st.toUpperCase())+'</span></div><div class="serviceMetrics"><div><small>FPS</small><b>'+esc(s.fps==null?"—":s.fps)+'</b></div><div><small>BITRATE</small><b>'+esc(s.video_bitrate_kbps==null?"—":s.video_bitrate_kbps)+' kbps</b></div><div><small>RESTARTS</small><b>'+esc(s.restarts==null?0:s.restarts)+'</b></div><div><small>ATUALIZADO</small><b style="font-size:9px">'+esc(fmt(s.updated_at))+'</b></div></div><div class="note" style="margin-top:10px"><b>Tocando agora:</b> '+esc(np.title||np.track_id||"aguardando faixa")+(np.started_at?" · "+esc(fmt(np.started_at)):"")+'</div><div class="visualBox"><div class="row between wrap"><div><b class="small">Vídeo / loop visual</b><div class="tiny muted" style="margin-top:3px">Atual: '+esc(shortUrl(loop))+'</div></div><span class="pill">AUTO LOOP</span></div><div class="visualRow"><select class="select visualSelect" data-slot="'+esc(slot)+'">'+visualOptions(loop)+'</select><button class="btn visualApply" data-slot="'+esc(slot)+'">Trocar vídeo</button></div><div class="tiny muted" style="margin-top:6px">A mudança é aplicada somente nesta live. As outras continuam intactas.</div></div>'+(s.controls_frozen?'<div class="note" style="margin-top:9px;color:#e7b965">A faixa atual está protegida pelo chat. Próxima e anterior ficarão disponíveis após o desbloqueio.</div>':'')+'<div class="serviceActions" style="margin-top:12px"><button class="btn primary ctl" data-slot="'+esc(slot)+'" data-action="restart">↻ Reiniciar encoder</button><button class="btn danger ctl" data-slot="'+esc(slot)+'" data-action="stop">■ Parar</button><button class="btn ctl" data-slot="'+esc(slot)+'" data-action="previous">↶ Faixa anterior</button><button class="btn ctl" data-slot="'+esc(slot)+'" data-action="skip">↷ Próxima faixa</button></div></section>'}
async function waitCommand(id,button,slot,action,previousTrack){
 if(!id)throw new Error("MediaForge não retornou o identificador do comando.");
 for(var n=0;n<48;n++){
   await new Promise(function(r){setTimeout(r,850)});
   var result=await api("/api/ovh/control/"+encodeURIComponent(id));
   var cmd=result.command||{},status=String(cmd.status||"");
   if(status==="failed")throw new Error(cmd.error||"O agente OVH recusou o comando.");
   if(status==="completed"){
     if((action==="skip"||action==="previous")&&previousTrack){
       for(var k=0;k<30;k++){
         var state=await api("/api/ovh/status"),svc=(state.agent&&state.agent.services||{})[slot]||{};
         var next=String((svc.now_playing||{}).track_id||"");
         if(next&&next!==previousTrack){if(button)button.textContent="✓ Faixa alterada";return true;}
         await new Promise(function(r){setTimeout(r,850)});
       }
       if(button)button.textContent="Faixa não mudou";
       throw new Error("A OVH recebeu o comando, mas a música não mudou. Verifique se há proteção de faixa ou bloqueio de áudio.");
     }
     if(button)button.textContent="✓ Confirmado pela OVH";
     return true;
   }
   if(button)button.textContent=status==="claimed"?"OVH processando…":"Na fila da OVH…";
 }
 if(button)button.textContent="Aguardando confirmação da OVH";
 return false;
}
async function uploadVideo(file,bar,label){if(!file)throw new Error("Selecione um arquivo.");if(!String(file.type||"").startsWith("video/"))throw new Error("Envie um arquivo de vídeo.");var init=await api("/api/uploads/init",{method:"POST",body:JSON.stringify({name:file.name,title:file.name,mime_type:file.type||"video/mp4",size_bytes:file.size,asset_type:"loop"})}),chunk=Number(init.chunk_size||50*1024*1024),parts=[],sent=0,part=1;try{while(sent<file.size){var blob=file.slice(sent,Math.min(file.size,sent+chunk));var r=await fetch(API+"/api/uploads/part?asset_id="+encodeURIComponent(init.asset_id)+"&upload_id="+encodeURIComponent(init.upload_id)+"&part_number="+part,{method:"PUT",headers:{authorization:"Bearer "+token()},body:blob});var d={};try{d=await r.json()}catch(e){}if(!r.ok)throw new Error(d.message||d.error||("Falha no upload HTTP "+r.status));parts.push({partNumber:d.partNumber,etag:d.etag});sent+=blob.size;part++;if(bar)bar.style.width=Math.round(sent/file.size*100)+"%";if(label)label.textContent="Enviando… "+Math.round(sent/file.size*100)+"%"}var done=await api("/api/uploads/complete",{method:"POST",body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id,parts:parts})});return done.asset}catch(e){try{await api("/api/uploads/abort",{method:"POST",body:JSON.stringify({asset_id:init.asset_id,upload_id:init.upload_id})})}catch(_){}throw e}}
function wireControls(){
 document.querySelectorAll(".ctl").forEach(function(b){b.onclick=async function(){
 var action=b.dataset.action,slot=b.dataset.slot,original=b.textContent;
 var svc=((window.__ovhLast||{}).agent||{}).services?.[slot]||{};
 if(!liveSlots((window.__ovhLast||{}).agent||{}).includes(slot)){alert("Essa transmissão não está ativa no último relatório da OVH. Atualize o painel.");return;}
 if((action==="stop"||action==="restart")&&!confirm((action==="stop"?"Parar":"Reiniciar")+" "+labelFor(slot,svc)+" agora?"))return;
 if((action==="skip"||action==="previous")&&svc.controls_frozen){alert("Faixa protegida pelo chat. Aguarde o desbloqueio antes de usar próxima ou anterior.");return;}
 var oldTrack=String((svc.now_playing||{}).track_id||"");
 b.disabled=true;
 try{
   var sent=await api("/api/ovh/control",{method:"POST",body:JSON.stringify({action:action,runtime_slot:slot,session_id:svc.session_id||""})});
   var id=sent&&sent.command&&sent.command.id;
   b.textContent="Comando enviado…";
   var confirmed=await waitCommand(id,b,slot,action,oldTrack);
   if(!confirmed){alert("Comando enviado, mas a OVH ainda não confirmou. Verifique o status antes de tentar novamente.");}
   await load();
 }catch(e){alert("Falha: "+e.message)}
 finally{setTimeout(function(){b.disabled=false;b.textContent=original},1500)}
 }}); 
 document.querySelectorAll(".visualApply").forEach(function(b){b.onclick=async function(){var slot=b.dataset.slot,sel=document.querySelector('.visualSelect[data-slot="'+slot+'"]'),assetId=sel&&sel.value,original=b.textContent;if(!assetId){alert("Selecione um vídeo salvo primeiro.");return}b.disabled=true;b.textContent="Preparando vídeo…";try{var sent=await api("/api/ovh/visual",{method:"POST",body:JSON.stringify({runtime_slot:slot,asset_id:assetId})});var id=sent&&sent.command&&sent.command.id;b.textContent="Aplicando…";await waitCommand(id,b);await load()}catch(e){alert("Falha ao trocar vídeo: "+e.message)}finally{setTimeout(function(){b.disabled=false;b.textContent=original},1500)}}});
 var input=document.getElementById("visualUpload"),btn=document.getElementById("uploadVisualBtn"),bar=document.getElementById("uploadProgress"),lbl=document.getElementById("uploadLabel");
 if(input)input.onchange=function(){if(lbl)lbl.textContent=input.files&&input.files[0]?input.files[0].name:"Nenhum vídeo selecionado"};
 if(btn)btn.onclick=async function(){var file=input&&input.files&&input.files[0];if(!file){alert("Selecione um vídeo primeiro.");return}btn.disabled=true;var original=btn.textContent;try{var a=await uploadVideo(file,bar,lbl);btn.textContent="✓ Vídeo salvo";var res=await api("/api/assets");assets=res.assets||[];render(window.__ovhLast||{});setTimeout(function(){document.querySelectorAll(".visualSelect").forEach(function(s){if([].some.call(s.options,function(o){return o.value===a.id}))s.value=a.id})},50)}catch(e){alert("Falha no upload: "+e.message)}finally{setTimeout(function(){btn.disabled=false;btn.textContent=original;if(bar)bar.style.width="0%"},1600)}}
}
function render(d){window.__ovhLast=d;var a=d.agent||{},host=a.host||{},services=a.services||{},slots=liveSlots(a),reported=a.reported_at||a.stored_at,age=reported?(Date.now()-new Date(reported).getTime())/1000:9999,online=age<75;el.innerHTML='<div class="row between wrap" style="margin-top:18px"><div><b>Servidor principal</b><div class="tiny muted" style="margin-top:4px">vps-82c820bf · 146.59.156.224 · Ubuntu · Docker</div></div><span class="pill '+(online?"online":"offline")+'">'+(online?"AGENT ONLINE":"SEM HEARTBEAT")+'</span></div><div class="grid hostgrid"><div class="card metric"><small>LOAD 1 MIN</small><b>'+esc(host.load_1m==null?"—":host.load_1m)+'</b></div><div class="card metric"><small>MEMÓRIA</small><b>'+esc(pct(host.memory_percent))+'</b></div><div class="card metric"><small>DISCO</small><b>'+esc(pct(host.disk_percent))+'</b></div><div class="card metric"><small>UPTIME</small><b>'+esc(dur(host.uptime_seconds))+'</b></div></div><div class="row between"><b>Transmissões ativas na OVH · '+slots.length+'</b><a class="btn" href="./lives.html">Abrir Central de Lives</a></div><div class="grid services" style="margin-top:10px">'+slots.map(function(slot){return serviceCard(slot,services[slot])}).join("")+(slots.length?"":'<div class="card" style="padding:20px;grid-column:1/-1">Nenhum encoder LIVE confirmado pela OVH. Nenhum controle será enviado sem telemetria atualizada.</div>')+'</div><section class="card uploadPanel"><div class="row between wrap"><div><b>Biblioteca de vídeos das lives</b><div class="tiny muted" style="margin-top:4px">Envie MP4/MOV uma vez e depois selecione o vídeo em qualquer serviço acima.</div></div><span class="pill">'+videos().length+' vídeos</span></div><div class="uploadRow"><label class="uploadPick"><input id="visualUpload" type="file" accept="video/mp4,video/quicktime,video/webm"><span id="uploadLabel">Selecionar vídeo…</span></label><button id="uploadVisualBtn" class="btn primary">↑ Enviar vídeo</button></div><div class="uploadBar"><span id="uploadProgress"></span></div></section><div class="note" style="margin-top:14px"><b>Arquitetura:</b> MediaForge envia comandos pelo Cloudflare D1; o agente da OVH aplica playlist, visual, start/stop/restart e reporta saúde ao Worker. Os encoders não dependem de GitHub Actions para permanecer no ar.</div>';wireControls()}
async function load(){try{var all=await Promise.all([api("/api/ovh/status"),api("/api/assets")]);assets=all[1].assets||[];render(all[0])}catch(e){el.innerHTML='<div class="card" style="color:#ffb2ba"><b>Falha ao carregar OVH</b><div class="small" style="margin-top:6px">'+esc(e.message)+'</div></div>'}}
document.getElementById("refresh").onclick=load;document.getElementById("logout").onclick=function(){localStorage.removeItem("mediaforge_token");location.replace("./secure.html")};load();setInterval(function(){if(document.visibilityState==="visible")load()},10000);
})();