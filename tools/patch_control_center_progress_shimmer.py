from pathlib import Path

p = Path('docs/control-center/app.html')
text = p.read_text(encoding='utf-8')

old_css = '.statusbar{height:7px;background:#1e222c;border-radius:999px;overflow:hidden}.statusbar>span{height:100%;display:block;background:linear-gradient(90deg,#579fff,#8f72ff);border-radius:999px;transition:width .5s}'
new_css = '.statusbar{height:7px;background:#1e222c;border-radius:999px;overflow:hidden}.statusbar>span{height:100%;display:block;background:linear-gradient(90deg,#579fff,#8f72ff);border-radius:999px;position:relative;overflow:hidden;transition:width .7s cubic-bezier(.22,.61,.36,1);box-shadow:0 0 12px rgba(115,126,255,.28)}.bigprogress.live .statusbar>span:after{content:"";position:absolute;top:-2px;bottom:-2px;width:42%;left:-48%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),rgba(255,255,255,.9),rgba(255,255,255,.18),transparent);filter:blur(.3px);transform:skewX(-18deg);animation:progressLight 1.45s ease-in-out infinite;pointer-events:none}.bigprogress.live .statusbar{box-shadow:0 0 18px rgba(113,105,255,.12)}@keyframes progressLight{0%{left:-48%;opacity:0}12%{opacity:.45}45%{opacity:1}78%{opacity:.5}100%{left:112%;opacity:0}}'

if 'progressLight 1.45s' not in text:
    if old_css not in text:
        raise SystemExit('statusbar CSS anchor not found')
    text = text.replace(old_css, new_css, 1)

old_html = """<div class=\"bigprogress\">'+progress(p.progress)+'<div class=\"percent\">"""
new_html = """<div class=\"bigprogress '+(!terminal.includes(p.status)?'live':'')+'\">'+progress(p.progress)+'<div class=\"percent\">"""
if old_html in text:
    text = text.replace(old_html, new_html, 1)
elif "bigprogress '+(!terminal.includes(p.status)?'live':'')+'" not in text:
    raise SystemExit('bigprogress HTML anchor not found')

p.write_text(text, encoding='utf-8')
print('Progress shimmer applied')
