import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createServer} from '../app/server.mjs';

const secret='whsec_'+Buffer.from('synthetic-webhook-secret-only-32bytes').toString('base64');
async function setup(t,overrides={}){
 const dir=await mkdtemp(join(tmpdir(),'native-mail-api-'));let sends=0;
 const mailProvider={send:async()=>{sends++;return{id:'provider-send-1'};},receive:async id=>({providerId:id,transportId:'<reply-1@example.com>',from:'Recruiter <recruiter@example.com>',to:[],subject:'Interview invitation',text:'We invite you to an interview. Please choose a time.',headers:{},attachments:[]}),...overrides};
 const env={MAIL_ALLOW_SEND:'1',RESEND_API_KEY:'synthetic-only',RESEND_RECEIVE_API_KEY:'synthetic-only',RESEND_WEBHOOK_SECRET:secret,MAIL_FROM:'applications@apply.rolemorrow.com',MAIL_REPLY_DOMAIN:'apply.rolemorrow.com',MAIL_RECIPIENT_ALLOWLIST:'controlled@example.com'};
 const storeFile=join(dir,'state.json');const server=createServer({storeFile,env,mailProvider});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body,method='POST')=>{const r=await fetch(base+path,{method,headers:{origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};};
 const state=async()=>(await call('/api/state',undefined,'GET')).data;
 t.after(async()=>{if(server.ingress?.listening)await new Promise(r=>server.ingress.close(r));await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 let r=await call('/api/intake/url',{url:'https://employer.example/jobs/1',title:'PM',baseRevision:0});assert.equal(r.status,200);const o=r.data.opportunities[0];
 r=await call('/api/applications/'+o.id,{revision:0,cvVersion:'Synthetic v1',cvText:'Fictional CV',coverLetter:'',answers:'',files:[]});assert.equal(r.status,200);
 return{server,call,state,o,mailProvider,env,storeFile,sends:()=>sends};
}
const dispatch=o=>({kind:'application',opportunityId:o.id,packetRevision:1,decisionRevision:0,to:'controlled@example.com',subject:'Synthetic application',body:'Please review my fictional application.',confirm:true});
test('NM01 saved packet dispatch is explicit, durable, idempotent and redacted',async t=>{
 const h=await setup(t);let r=await h.call('/api/mail/dispatches',dispatch(h.o));assert.equal(r.status,200);assert.equal(h.sends(),1);
 assert.equal(r.data.mailDispatches[0].status,'accepted');assert.equal(r.data.opportunities[0].stage,'saved');
 const d=r.data.mailDispatches[0];assert.ok(!JSON.stringify(d).includes('synthetic-only'));assert.ok(!JSON.stringify(d).includes('base64'));
 r=await h.call('/api/mail/dispatches',dispatch(h.o));assert.equal(r.status,200);assert.equal(h.sends(),1);assert.equal(r.data.mailDispatches.length,1);
 assert.equal((await h.call('/api/mail/dispatches',{...dispatch(h.o),to:'other@example.com'})).status,403);
 assert.equal((await h.call('/api/mail/dispatches',{...dispatch(h.o),confirm:false})).status,400);
});
test('NM02 unknown send retries same frozen snapshot and key',async t=>{
 const calls=[];let fail=true;const h=await setup(t,{send:async(payload,options)=>{calls.push({payload,options});if(fail){fail=false;throw Error('timeout including secret should never escape');}return{id:'retry-provider'};}});
 let r=await h.call('/api/mail/dispatches',dispatch(h.o));assert.equal(r.status,200);assert.equal(r.data.mailDispatches[0].status,'unknown');
 const d=r.data.mailDispatches[0];r=await h.call('/api/mail/dispatches/'+d.id+'/retry',{revision:d.revision,confirm:true});assert.equal(r.status,200);assert.equal(r.data.mailDispatches[0].status,'accepted');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);
});
test('NM03 dedicated signed ingress receives reply once, notifies once and exposes no workspace',async t=>{
 const h=await setup(t);await h.call('/api/mail/dispatches',dispatch(h.o));
 assert.ok(h.server.ingress,'separate webhook server exists');await new Promise(r=>h.server.ingress.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${h.server.ingress.address().port}`;
 h.mailProvider.receive=async id=>({providerId:id,transportId:'<reply-1@example.com>',from:'recruiter@example.com',to:[`op-${h.o.id}@apply.rolemorrow.com`],subject:'Interview',text:'We invite you to an interview. Please choose a time.',headers:{},attachments:[]});
 const event={type:'email.received',created_at:new Date().toISOString(),data:{email_id:'incoming-1'}};const raw=JSON.stringify(event),ts=String(Math.floor(Date.now()/1000)),id='event-inbound-1';const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
 const post=()=>fetch(base+'/hooks/resend',{method:'POST',headers:{'content-type':'application/json','svix-id':id,'svix-timestamp':ts,'svix-signature':'v1,'+signature},body:raw});
 assert.equal((await fetch(base+'/api/state')).status,404);assert.equal((await fetch(base+'/hooks/resend',{method:'POST',headers:{'content-type':'application/json'},body:raw})).status,401);
 assert.equal((await post()).status,200);assert.equal((await post()).status,200);let s=await h.state();assert.equal(s.messages.filter(m=>m.origin==='resend').length,1);assert.equal(s.notifications.length,1);assert.equal(s.messages[0].opportunityId,h.o.id);assert.equal(s.opportunities[0].stage,'saved');
 const n=s.notifications[0];const r=await h.call('/api/mail/notifications/'+n.id,{revision:n.revision,read:true});assert.equal(r.status,200);assert.equal(r.data.notifications[0].read,true);assert.equal(r.data.messages[0].task.done,false);
});
test('NM04 deletion during an in-flight send cannot restore the dispatch or packet',async t=>{
 let release,started;const began=new Promise(r=>started=r);const h=await setup(t,{send:()=>{started();return new Promise(r=>release=r);}});
 const sending=h.call('/api/mail/dispatches',dispatch(h.o));await began;
 let s=await h.state();assert.equal(s.mailDispatches[0].status,'sending');
 assert.equal((await h.call('/api/data',{},'DELETE')).status,200);release({id:'deleted-send'});await sending;
 s=await h.state();assert.deepEqual(s.mailDispatches,[]);assert.deepEqual(s.applications,[]);assert.deepEqual(s.opportunities,[]);
});
test('NM05 interrupted send recovers as unknown after process restart and keeps its frozen key',async t=>{
 let release,started;const began=new Promise(r=>started=r);const h=await setup(t,{send:()=>{started();return new Promise(r=>release=r);}});
 const sending=h.call('/api/mail/dispatches',dispatch(h.o));await began;
 const stored=JSON.parse(await readFile(h.storeFile,'utf8'));assert.equal(stored.mailDispatches[0].status,'sending');
 const replacement=createServer({storeFile:h.storeFile,env:h.env,mailProvider:h.mailProvider});await new Promise(r=>replacement.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${replacement.address().port}/api/state`);const s=await r.json();assert.equal(s.mailDispatches[0].status,'unknown');assert.equal(s.mailDispatches[0].attempts,1);const disk=JSON.parse(await readFile(h.storeFile,'utf8'));assert.equal(disk.mailDispatches[0].idempotencyKey,stored.mailDispatches[0].idempotencyKey);}
 finally{await new Promise(r=>replacement.close(r));release({id:'late-old-process'});await sending;}
});
