import fs from 'node:fs';

const projectRef=process.env.MFCC_SUPABASE_PROJECT_REF||'fykwalznmcrjgnyveagy';
const productionId=process.env.MFCC_PRODUCTION_ID;
const kind=process.env.MFCC_OUTPUT_KIND||'video';
const filePath=process.env.MFCC_OUTPUT_FILE;
if(!productionId||!filePath) throw new Error('MFCC_PRODUCTION_ID and MFCC_OUTPUT_FILE are required');

async function oidc(){
  const base=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!base||!reqToken) throw new Error('GitHub OIDC is unavailable; workflow needs id-token: write');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent('mfcc-storage');
  const r=await fetch(url,{headers:{Authorization:`Bearer ${reqToken}`}});
  if(!r.ok) throw new Error(`OIDC request failed ${r.status}: ${await r.text()}`);
  return (await r.json()).value;
}

async function edge(token,payload){
  const r=await fetch(`https://${projectRef}.supabase.co/functions/v1/mfcc-storage-ticket`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  const text=await r.text();
  let data;try{data=JSON.parse(text)}catch{data={raw:text}}
  if(!r.ok) throw new Error(`Storage ticket failed ${r.status}: ${text}`);
  return data;
}

const fileSize=fs.statSync(filePath).size;
const identity=await oidc();
const ticket=await edge(identity,{production_id:productionId,kind,action:'ticket',size:fileSize});
if(!ticket.signed_url) throw new Error('Storage ticket did not return a signed upload URL');
console.log(`Uploading ${kind} (${fileSize} bytes) -> ${ticket.path}`);

const upload=await fetch(ticket.signed_url,{
  method:'PUT',
  headers:{
    'Content-Type':ticket.content_type||'application/octet-stream',
    'Content-Length':String(fileSize),
    'Cache-Control':'max-age=3600',
    'x-upsert':'true'
  },
  body:fs.createReadStream(filePath),
  duplex:'half'
});
if(!upload.ok) throw new Error(`Signed upload failed ${upload.status}: ${await upload.text()}`);
console.log(`${kind}: upload complete.`);

const identity2=await oidc();
await edge(identity2,{production_id:productionId,kind,action:'complete',size:fileSize});
console.log(`${kind} stored successfully.`);
