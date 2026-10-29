// Operator-only authenticated pull for the owner's isolated smoke conversation.
// This is NOT a webhook event and never fabricates a provider signature.
import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {createResendAdapter} from './resend.mjs';
import {receiveResend} from './mail-transport.mjs';
if(process.env.CONFIRM_MAIL_RECEIVE_SMOKE!=='1')throw Error('Explicit receive smoke confirmation required.');
const store='/app/data/mail-smoke-2026-10-19/state.json',dir='/app/data/mail-smoke-2026-10-19';
const key=process.env.RESEND_RECEIVE_API_KEY,owner=process.env.MAIL_SMOKE_TO;
if(!key||!owner)throw Error('Receiving key and controlled sender are required.');
await mkdir(dir+'/receive.lock');
try{
 const before=await readFile(store,'utf8'),state=JSON.parse(before);
 const dispatch=state.mailDispatches.find(d=>d.to===owner&&d.subject==='[Rolemorrow test] Delivery check 2026-10-19');
 if(!dispatch)throw Error('Original controlled dispatch not found.');
 const r=await fetch('https://api.resend.com/emails/receiving?limit=20',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(`Receiving list rejected (${r.status}); no message stored.`);
 let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>1048576)throw Error('Receiving list too large.');chunks.push(chunk);}
 const list=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!Array.isArray(list.data))throw Error('Invalid receiving list.');
 const plain=value=>String(value).match(/<([^<>]+)>$/)?.[1]?.toLowerCase()??String(value).toLowerCase();
 const found=list.data.find(m=>Array.isArray(m.to)&&m.to.some(to=>plain(to)===dispatch.replyTo)&&plain(m.from)===owner.toLowerCase()&&String(m.subject).includes(dispatch.subject)&&Date.parse(m.created_at)>=Date.parse(dispatch.createdAt));
 if(!found){console.log(JSON.stringify({status:'reply-not-found',checkedLatest:Math.min(list.data.length,20),automaticWebhook:false}));process.exitCode=2;}
 else{
  const adapter=createResendAdapter({receiveKey:key});const incoming=await adapter.receive(found.id);
  const stage=state.opportunities.find(o=>o.id===dispatch.opportunityId)?.stage;
  const message=receiveResend(state,incoming,{replyDomain:'apply.rolemorrow.com'});
  if(message.opportunityId!==dispatch.opportunityId)throw Error('Reply was not associated with the original opportunity.');
  const notifications=state.notifications.filter(n=>n.messageId===message.id);
  if(notifications.length!==1)throw Error('Exactly one notification required.');
  receiveResend(state,incoming,{replyDomain:'apply.rolemorrow.com'});
  if(state.notifications.filter(n=>n.messageId===message.id).length!==1)throw Error('Replay duplicated the notification.');
  if(state.opportunities.find(o=>o.id===dispatch.opportunityId)?.stage!==stage)throw Error('Reply changed candidate stage.');
  if(await readFile(store,'utf8')!==before)throw Error('Workspace changed during receive.');
  try{await writeFile(store+'.pre-receive.bak',before,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  state.revision++;await writeFile(store+'.tmp',JSON.stringify(state),{mode:0o600});await rename(store+'.tmp',store);
  const evidence={status:'reply-received-and-linked',checkedAt:new Date().toISOString(),providerId:found.id,messageId:message.id,opportunityId:message.opportunityId,notificationId:notifications[0].id,notificationRead:notifications[0].read,replayDeduplicated:true,stageUnchanged:true,automaticWebhook:false,mode:'authenticated-operator-pull'};
  await writeFile(dir+'/receive-receipt.json',JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
 }
}finally{await rm(dir+'/receive.lock',{recursive:true});}
