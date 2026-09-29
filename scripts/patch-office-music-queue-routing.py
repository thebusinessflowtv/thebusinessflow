from pathlib import Path

JS_FILES = [Path('control-center/office-music.js'), Path('docs/control-center/office-music.js')]
HTML_FILES = [Path('control-center/office-music.html'), Path('docs/control-center/office-music.html')]

old = """  async function invoke(body){
    const {data,error}=await client.functions.invoke('office-music-control',{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  }
"""
new = """  async function invoke(body){
    const queueAction=body?.action==='create_job'||body?.action==='start_live';
    const functionName=queueAction?'office-music-queue-control':'office-music-control';
    const {data,error}=await client.functions.invoke(functionName,{body});
    if(error)throw error;
    if(data?.error)throw new Error(data.message||data.error);
    return data;
  }
"""

for path in JS_FILES:
    s=path.read_text(encoding='utf-8')
    if old not in s:
        if "office-music-queue-control" in s:
            continue
        raise SystemExit(f'invoke anchor missing in {path}')
    path.write_text(s.replace(old,new,1),encoding='utf-8')

for path in HTML_FILES:
    s=path.read_text(encoding='utf-8')
    s=s.replace('office-music.js?v=20260929-5','office-music.js?v=20260929-6')
    path.write_text(s,encoding='utf-8')
