from pathlib import Path

FILES = [
    Path('control-center/office-music.js'),
    Path('docs/control-center/office-music.js'),
]
HTML_FILES = [
    Path('control-center/office-music.html'),
    Path('docs/control-center/office-music.html'),
]

NEW_FUNCTION = r'''  function renderGenerate(){
    const root=document.getElementById('view-generate'); if(!root)return;
    const thumb=state.assets.find(a=>a.asset_type==='thumbnail'&&a.is_default);
    const images=state.assets.filter(a=>a.asset_type==='thumbnail');
    const defaultImage=thumb||images[0]||null;
    root.innerHTML=`<div class="grid grid2">
      <div class="grid">
        <div class="card hero">
          <div class="label">Music Generator</div>
          <h2 style="margin-top:8px">Gerar sessão completa</h2>
          <p class="small muted" style="line-height:1.6;margin:6px 0 18px">Escolha a duração e o visual. Cada solicitação gera um conjunto novo de músicas; áudio de jobs anteriores nunca é usado para completar a duração.</p>
          <div class="field"><label>Duração total</label><div class="row"><input id="duration" class="input duration" type="number" min="6" max="360" step="1" value="60" style="max-width:170px"><b class="muted">min</b></div><div class="chips">${[30,60,90,120,180].map(x=>`<button class="chip ${x===60?'on':''}" data-min="${x}">${x} min</button>`).join('')}</div></div>
          <div class="field"><label>Visual do vídeo</label><select id="visualMode" class="select"><option value="video">Vídeo em loop — master do GitHub</option><option value="image">Imagem fixa — durante o vídeo inteiro</option></select><div class="tiny muted" style="margin-top:6px">No modo vídeo, usamos o master oficial salvo no GitHub. No modo imagem, a imagem selecionada permanece 100% fixa do início ao fim.</div></div>
          <div class="field hidden" id="fixedImageField"><label>Imagem fixa</label><select id="fixedImage" class="select" ${images.length?'':'disabled'}>${images.length?images.map(a=>`<option value="${esc(a.id)}" ${defaultImage&&a.id===defaultImage.id?'selected':''}>${esc(a.title||'Imagem')}</option>`).join(''):'<option value="">Nenhuma imagem cadastrada em Assets</option>'}</select><div class="tiny muted" style="margin-top:6px">Você pode enviar novas imagens na aba Assets e depois selecioná-las aqui.</div></div>
          <div class="grid" style="grid-template-columns:repeat(3,1fr);margin:18px 0"><div class="metric"><small>MÚSICA</small><b>100% nova por job</b></div><div class="metric"><small>VÍDEO</small><b>4K · 3840×2160</b></div><div class="metric"><small>YOUTUBE</small><b>Público automático</b></div></div>
          <div class="note"><b>Proteção contra repetição ativada.</b> Cada job recebe uma seed própria vinculada ao novo ID. Se não houver músicas novas e únicas suficientes para preencher a duração, a produção falha em vez de repetir uma faixa ou reutilizar áudio antigo.<br><br>Vídeo padrão: <b>GitHub Release office-assets-v1 · office-music-master-loop.mp4</b>${thumb?'<br>Thumbnail padrão: <b>'+esc(thumb.title||'Thumbnail')+'</b>':''}</div>
          <button id="generateBtn" class="btn primary block" style="margin-top:16px;min-height:45px">♫ Gerar músicas novas + vídeo 4K + publicar</button>
        </div>
        <div class="card pad"><div class="row between"><h3 class="section-title" style="margin:0">Gerações</h3><button id="refreshJobs" class="btn">↻ Atualizar</button></div><div class="list" style="margin-top:12px">${jobsHtml()}</div></div>
      </div>
      <div class="grid">
        <div class="card pad"><div class="label">Fluxo automático</div><div class="list" style="margin-top:12px"><div class="metric"><small>01</small><b>Geração musical inédita</b><div class="tiny muted">Medium → Small fallback. Se ambos falharem, o job para; não existe fallback para música antiga.</div></div><div class="metric"><small>02</small><b>Validação anti-repetição</b><div class="tiny muted">Hash das faixas + ID da solicitação + duração única suficiente. Nenhuma faixa é ciclada para completar o mix.</div></div><div class="metric"><small>03</small><b>Visual selecionável</b><div class="tiny muted">Master em vídeo do GitHub ou imagem totalmente fixa.</div></div><div class="metric"><small>04</small><b>Publicação</b><div class="tiny muted">Render 4K + upload resumível + título + descrição + capítulos</div></div></div></div>
        <div class="card pad"><h3 class="section-title">DNA musical fixo</h3><div class="small muted" style="line-height:1.7">120–123 BPM · fashion-retail deep/lounge house · kick 4/4 limpo · baixo arredondado · hats nítidos · synth plucks minimalistas · pads quentes · energia 6/10 · instrumental · sem drops agressivos · mix comercial premium para escritório/home office.</div></div>
      </div>
    </div>`;
    root.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{root.querySelector('#duration').value=b.dataset.min;root.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===b))});
    const mode=root.querySelector('#visualMode');
    const fixed=root.querySelector('#fixedImageField');
    const updateVisual=()=>fixed.classList.toggle('hidden',mode.value!=='image');
    mode.onchange=updateVisual; updateVisual();
    root.querySelector('#refreshJobs').onclick=refresh;
    root.querySelector('#generateBtn').onclick=async()=>{
      const btn=root.querySelector('#generateBtn');
      const duration=Math.max(6,Math.min(360,Number(root.querySelector('#duration').value||60)));
      const visualMode=mode.value==='image'?'image':'video';
      const visualAssetId=visualMode==='image'?(root.querySelector('#fixedImage')?.value||''):'';
      if(visualMode==='image'&&!visualAssetId){toast('Selecione uma imagem','Cadastre ou selecione uma imagem na aba Assets antes de gerar.','error');return}
      btn.disabled=true; btn.textContent='Criando produção…';
      try{
        await invoke({action:'create_job',duration_minutes:duration,publish:true,privacy:'public',visual_mode:visualMode,visual_asset_id:visualAssetId||null});
        toast('Produção iniciada',`${duration} minutos · ${visualMode==='image'?'imagem fixa':'vídeo do GitHub'} · músicas novas · publicação pública`);
        await refresh();
      }
      catch(e){toast('Falha ao iniciar',e.message||String(e),'error');btn.disabled=false;btn.textContent='♫ Gerar músicas novas + vídeo 4K + publicar'}
    };
  }

'''

for path in FILES:
    text = path.read_text(encoding='utf-8')
    start = text.index('  function renderGenerate(){')
    end = text.index('  function tracksPicker(){', start)
    text = text[:start] + NEW_FUNCTION + text[end:]
    path.write_text(text, encoding='utf-8')

for path in HTML_FILES:
    text = path.read_text(encoding='utf-8')
    text = text.replace('./office-music.js?v=20260929-3', './office-music.js?v=20260929-4')
    path.write_text(text, encoding='utf-8')

print('Office Music generator UI patched in control-center and docs mirror.')
