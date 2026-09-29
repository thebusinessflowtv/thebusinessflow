const fs=require('fs');
const paths=['control-center/office-music.js','docs/control-center/office-music.js'];
const oldHeader='<div class="grid"><div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Lives</h3><button id="refreshLives" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">${liveSessionsHtml()}</div></div><div class="card pad"><h3 class="section-title">Configuração automática</h3>';
const newHeader='<div class="grid"><div class="card pad"><div class="row between wrap"><h3 class="section-title" style="margin:0">Lives</h3><div class="row wrap"><button id="clearLiveLogs" class="btn danger">Limpar logs</button><button id="refreshLives" class="btn">↻ Atualizar</button></div></div><div class="tiny muted" style="margin-top:7px">Limpar logs remove apenas lives encerradas ou com falha. Uma transmissão ativa nunca é apagada.</div><div class="list" style="margin-top:12px">${liveSessionsHtml()}</div></div><div class="card pad"><h3 class="section-title">Configuração automática</h3>';
const oldHandler="    root.querySelector('#refreshLives').onclick=refresh;\n";
const newHandler=`    root.querySelector('#refreshLives').onclick=refresh;
    const clearLiveLogs=root.querySelector('#clearLiveLogs');
    if(clearLiveLogs)clearLiveLogs.onclick=async()=>{
      if(!confirm('Limpar o histórico de lives encerradas e com falha? Lives ativas não serão removidas.'))return;
      clearLiveLogs.disabled=true;clearLiveLogs.textContent='Limpando…';
      try{
        const {error}=await client.from('office_music_live_sessions').delete().in('status',['failed','completed']);
        if(error)throw error;
        toast('Logs de lives limpos','Foram removidas apenas transmissões encerradas ou com falha.');
        await refresh();
      }catch(e){toast('Falha ao limpar logs',e.message||String(e),'error');clearLiveLogs.disabled=false;clearLiveLogs.textContent='Limpar logs'}
    };
`;
for(const p of paths){
  let s=fs.readFileSync(p,'utf8');
  let changed=false;
  if(!s.includes('id="clearLiveLogs"')){
    if(!s.includes(oldHeader))throw new Error(`Live header pattern not found in ${p}`);
    s=s.replace(oldHeader,newHeader);changed=true;
  }
  if(!s.includes("client.from('office_music_live_sessions').delete().in('status',['failed','completed'])")){
    if(!s.includes(oldHandler))throw new Error(`Refresh handler pattern not found in ${p}`);
    s=s.replace(oldHandler,newHandler);changed=true;
  }
  if(changed){fs.writeFileSync(p,s);console.log('Patched',p)}else console.log('Already patched',p);
}
