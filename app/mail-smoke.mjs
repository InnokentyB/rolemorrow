// Explicit operator-only smoke: one controlled recipient, durable isolated store.
import {createServer} from './server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

if(process.env.CONFIRM_MAIL_SMOKE!=='1')throw Error('Explicit smoke confirmation required.');
const to=process.env.MAIL_SMOKE_TO;
if(!to||process.env.MAIL_RECIPIENT_ALLOWLIST!==to)throw Error('Exactly one controlled allowlisted recipient required.');
const storeFile='/app/data/mail-smoke-2026-10-19/state.json';
const server=createServer({storeFile});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
async function call(path,body,method='POST'){
 const r=await fetch(base+path,{method,headers:{origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await r.json();if(!r.ok)throw Error(`Local smoke action failed (${r.status}).`);return data;
}
try{
 let s=await call('/api/state',undefined,'GET');
 const url='https://rolemorrow.com/mail-smoke/2026-10-19';
 if(!s.opportunities.some(o=>o.snapshot.url===url))s=await call('/api/intake/url',{url,title:'Rolemorrow controlled mail test',company:'Rolemorrow',baseRevision:s.revision});
 const o=s.opportunities.find(o=>o.snapshot.url===url);
 if(!s.applications.some(a=>a.opportunityId===o.id))s=await call('/api/applications/'+o.id,{revision:0,cvVersion:'Fictional mail smoke v1',cvText:'Synthetic test packet. No personal CV or employer application.',coverLetter:'',answers:'',files:[]});
 const packet=s.applications.find(a=>a.opportunityId===o.id);
 s=await call('/api/mail/dispatches',{kind:'application',opportunityId:o.id,packetRevision:packet.revision,decisionRevision:o.decisionRevision,to,subject:'[Rolemorrow test] Delivery check 2026-10-19',body:'Это тестовое письмо Rolemorrow, отправленное с твоего разрешения. Это не отклик работодателю.\n\nДля проверки приёма ответь на это письмо: Rolemorrow reply test. Ответ будет направлен на отдельный адрес этой тестовой переписки.',confirm:true});
 const d=s.mailDispatches.find(d=>d.opportunityId===o.id);
 let providerStatus=null;
 if(d.providerId&&process.env.RESEND_RECEIVE_API_KEY){
  try{const r=await fetch('https://api.resend.com/emails/'+encodeURIComponent(d.providerId),{headers:{Authorization:'Bearer '+process.env.RESEND_RECEIVE_API_KEY},redirect:'error',signal:AbortSignal.timeout(20000)});if(r.ok){const data=await r.json();providerStatus=typeof data.last_event==='string'?data.last_event:null;}}catch{}
 }
 const evidence={checkedAt:new Date().toISOString(),dispatchId:d.id,status:d.status,providerId:d.providerId,providerStatus,replyTo:d.replyTo,recipient:to,store:storeFile};
 await mkdir(dirname(storeFile),{recursive:true,mode:0o700});await writeFile(dirname(storeFile)+'/receipt.json',JSON.stringify(evidence,null,2),{mode:0o600});
 console.log(JSON.stringify(evidence));
 if(!['accepted','delivered'].includes(d.status))process.exitCode=2;
}finally{await new Promise(r=>server.close(r));}
