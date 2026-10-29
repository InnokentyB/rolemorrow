import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {createServer} from '../app/server.mjs';
const signingSecret='whsec_'+Buffer.from('synthetic-production-safety-signing-secret').toString('base64');
const empty=()=>({revision:0,profile:null,companies:[],run:null,history:[],opportunities:[],applications:[],messages:[],replyDrafts:[],mailDispatches:[],mailEvents:[],notifications:[],webhookReceipts:[],mailSchema:1});
async function harness(t,{seed=empty(),receive}={}){
 const directory=await mkdtemp(join(tmpdir(),'rolemorrow-production-safety-')),storeFile=join(directory,'state.json');await writeFile(storeFile,JSON.stringify(seed),{mode:0o600});let reads=0;
 const env={RESEND_API_KEY:'synthetic-send-key',RESEND_RECEIVE_API_KEY:'synthetic-read-key',RESEND_WEBHOOK_SECRET:signingSecret,MAIL_REPLY_DOMAIN:'reply.example.com'};
 const server=createServer({storeFile,env,mailProvider:{send:async()=>{throw Error('Sending must remain disabled');},receive:receive??(async id=>{reads++;return {providerId:id,transportId:id,messageId:'<message@example.com>',from:'recruiter@example.com',to:['orphan@reply.example.com'],subject:'Private reply',text:'Sensitive synthetic reply body',files:[],attachments:[]};})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));await new Promise(r=>server.ingress.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,ingress=`http://127.0.0.1:${server.ingress.address().port}`;
 t.after(async()=>{if(server.ingress.listening)await new Promise(r=>server.ingress.close(r));await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
 const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const post=(id='event-privacy-1',emailId='received-privacy-1')=>{const raw=JSON.stringify({type:'email.received',data:{email_id:emailId}}),timestamp=String(Math.floor(Date.now()/1000)),sig=createHmac('sha256',Buffer.from(signingSecret.slice(6),'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');return fetch(ingress+'/hooks/resend',{method:'POST',headers:{'content-type':'application/json','svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+sig},body:raw});};
 return {server,storeFile,base,ingress,call,post,reads:()=>reads};
}
test('PS01 private UI rejects foreign Host and cross-origin writes; ingress exposes no local data',async t=>{
 const h=await harness(t);
 const foreign=await new Promise((resolve,reject)=>{const req=http.request(h.base+'/api/state',{headers:{Host:'public.example.com'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(foreign,403);
 assert.equal((await h.call('/api/data',{method:'DELETE',body:{},headers:{Origin:'https://attacker.example.com'}})).status,403);
 assert.equal((await fetch(h.ingress+'/api/state')).status,404);
 assert.equal((await fetch(h.ingress+'/api/data',{method:'DELETE'})).status,404);
 assert.equal((await h.call('/api/mail/dispatches',{method:'POST',body:{confirm:true}})).status,503);
 const state=(await h.call('/api/state')).data;assert.equal(state.mailTransport.sendReady,false);assert.equal(JSON.stringify(state).includes('synthetic-read-key'),false);assert.equal(JSON.stringify(state).includes(signingSecret),false);
});
test('PS02 signed ingress persists private receipts and deduplicates provider retries',async t=>{
 const h=await harness(t);assert.equal((await h.post()).status,200);assert.equal((await h.post()).status,200);assert.equal(h.reads(),1);
 const state=JSON.parse(await readFile(h.storeFile,'utf8'));assert.equal(state.messages.length,1);assert.equal(state.notifications.length,1);assert.equal(state.webhookReceipts.length,1);assert.equal((await stat(h.storeFile)).mode&0o777,0o600);
 assert.equal(JSON.stringify((await h.call('/api/state')).data).includes('webhookReceipts'),false);
});
test('PS03 deleting the workspace must prevent provider retries resurrecting deleted correspondence',async t=>{
 const h=await harness(t);assert.equal((await h.post()).status,200);assert.equal((await h.call('/api/state')).data.messages.length,1);
 assert.equal((await h.call('/api/data',{method:'DELETE',body:{}})).status,200);
 await h.post();const state=(await h.call('/api/state')).data;assert.equal(state.messages.length,0,'Provider retry restored a deleted private message');assert.equal(state.notifications.length,0);
});

test('PS04 deletion pauses receiving durably and acknowledges new signed events without fetching bodies',async t=>{
 const h=await harness(t);assert.equal((await h.call('/api/data',{method:'DELETE',body:{}})).status,200);const before=h.reads();assert.equal((await h.post('event-after-delete','email-after-delete')).status,200);assert.equal(h.reads(),before);
 const saved=JSON.parse(await readFile(h.storeFile,'utf8'));assert.equal(saved.mailReceivingPaused,true);assert.equal(saved.messages.length,0);assert.equal((await h.call('/api/state')).data.mailTransport.receiveReady,false);
});
test('PS05 deletion removes app-managed sensitive backups but keeps only content-free replay tombstones',async t=>{
 const h=await harness(t);await h.post();await writeFile(h.storeFile+'.pre-tracking.bak','sensitive old profile');await writeFile(h.storeFile+'.pre-mail.bak','sensitive old correspondence');
 assert.equal((await h.call('/api/data',{method:'DELETE',body:{}})).status,200);const disk=JSON.parse(await readFile(h.storeFile,'utf8'));assert.equal(disk.webhookReceipts.length,1);assert.equal(JSON.stringify(disk).includes('Sensitive synthetic reply body'),false);assert.equal(JSON.stringify(disk).includes('recruiter@example.com'),false);assert.deepEqual(disk.messages,[]);assert.deepEqual(disk.applications,[]);assert.deepEqual(disk.mailDispatches,[]);
 for(const suffix of ['.pre-tracking.bak','.pre-mail.bak'])await assert.rejects(readFile(h.storeFile+suffix),e=>e.code==='ENOENT');
});
test('PS06 receiving pause survives app restart instead of trusting only in-memory generation',async t=>{
 const h=await harness(t);await h.call('/api/data',{method:'DELETE',body:{}});await new Promise(r=>h.server.close(r));
 let reads=0;const restarted=createServer({storeFile:h.storeFile,env:{RESEND_RECEIVE_API_KEY:'synthetic-read',RESEND_WEBHOOK_SECRET:signingSecret,MAIL_REPLY_DOMAIN:'reply.example.com'},mailProvider:{receive:async()=>{reads++;throw Error('Must stay paused');}}});await new Promise(r=>restarted.listen(0,'127.0.0.1',r));await new Promise(r=>restarted.ingress.listen(0,'127.0.0.1',r));
 try{const data=await(await fetch(`http://127.0.0.1:${restarted.address().port}/api/state`)).json();assert.equal(data.mailTransport.receiveReady,false);assert.equal(data.mailTransport.receivingPaused,true);assert.equal(reads,0);}finally{await new Promise(r=>restarted.ingress.close(r));await new Promise(r=>restarted.close(r));}
});
