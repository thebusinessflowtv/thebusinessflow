import fs from 'node:fs';
import path from 'node:path';

const projectRef=process.env.MFCC_SUPABASE_PROJECT_REF||'fykwalznmcrjgnyveagy';
const productionId=process.env.MFCC_PRODUCTION_ID;
const hlsDir=process.env.MFCC_HLS_DIR;
if(!productionId||!hlsDir) throw new Error('MFCC_PRODUCTION_ID and MFCC_HLS_DIR are required');

async function oidc(){
  const base=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!base||!reqToken) throw new Error('GitHub OIDC is unavailable; workflow needs id-token: write');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent('mfcc-storage');
  const r=await fetch(url,{headers:{Authorization:`Bearer ${reqToken}`}});
  if(!r.ok) throw new Error(`OIDC request failed ${r.status}: ${await r.text()}`);
  return (await r.json()).value;
}

async function edge(payload){
  const token=await oidc();
  const r=await fetch(`https://${projectRef}.supabase.co/functions/v1/mfcc-storage-ticket`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  const text=await r.text();
  if(!r.ok) throw new Error(`Storage ticket failed ${r.status}: ${text}`);
  return JSON.parse(text);
}

const entries=fs.readdirSync(hlsDir).filter(f=>f==='index.m3u8'||f.endsWith('.ts')).sort((a,b)=>{
  if(a==='index.m3u8') return 1;
  if(b==='index.m3u8') return -1;
  return a.localeCompare(b);
});
if(!entries.includes('index.m3u8')) throw new Error('HLS playlist index.m3u8 not found');

let done=0;
for(const name of entries){
  const filePath=path.join(hlsDir,name);
  const stat=fs.statSync(filePath);
  const ticket=await edge({production_id:productionId,kind:'hls_file',relative_path:name,action:'ticket',size:stat.size});
  if(!ticket.signed_url) throw new Error(`No signed URL returned for ${name}`);
  const upload=await fetch(ticket.signed_url,{
    method:'PUT',
    headers:{
      'Content-Type':ticket.content_type||'application/octet-stream',
      'Content-Length':String(stat.size),
      'Cache-Control':name.endsWith('.m3u8')?'no-cache':'max-age=21600',
      'x-upsert':'true'
    },
    body:fs.createReadStream(filePath),
    duplex:'half'
  });
  if(!upload.ok) throw new Error(`Upload ${name} failed ${upload.status}: ${await upload.text()}`);
  done++;
  console.log(`HLS ${done}/${entries.length}: ${name} (${stat.size} bytes)`);
}

const segmentCount=entries.filter(f=>f.endsWith('.ts')).length;
await edge({production_id:productionId,action:'hls_manifest',segment_count:segmentCount,resolution:'3840x2160'});
console.log(`HLS streaming package stored successfully: ${segmentCount} segments.`);
