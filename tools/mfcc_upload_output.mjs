import fs from 'node:fs';
import * as tus from 'tus-js-client';

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
console.log(`Uploading ${kind} (${fileSize} bytes) -> ${ticket.path}`);

await new Promise((resolve,reject)=>{
  const upload=new tus.Upload(fs.createReadStream(filePath),{
    endpoint:`https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
    uploadSize:fileSize,
    retryDelays:[0,3000,5000,10000,20000],
    headers:{'x-signature':ticket.token},
    uploadDataDuringCreation:true,
    removeFingerprintOnSuccess:true,
    chunkSize:6*1024*1024,
    metadata:{bucketName:ticket.bucket,objectName:ticket.path,contentType:ticket.content_type,cacheControl:'3600'},
    onError:reject,
    onProgress:(done,total)=>{
      const pct=((done/total)*100).toFixed(1);
      process.stdout.write(`\r${kind}: ${pct}%`);
    },
    onSuccess:()=>{process.stdout.write(`\r${kind}: 100.0%\n`);resolve();}
  });
  upload.start();
});

const identity2=await oidc();
await edge(identity2,{production_id:productionId,kind,action:'complete',size:fileSize});
console.log(`${kind} stored successfully.`);
