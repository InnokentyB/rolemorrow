import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createResendAdapter,verifyResendWebhook} from '../app/resend.mjs';
const payload={from:'candidate@example.com',to:['recruiter@example.com'],subject:'Re: Interview',text:'Thank you.',headers:{'In-Reply-To':'<parent@example.com>',References:'<parent@example.com>'}};
const response=data=>new Response(JSON.stringify(data),{status:200});
const secret='whsec_'+Buffer.from('fake-test-signing-secret-32-bytes!').toString('base64');
function signed(body,offset=0){const timestamp=String(Math.floor(Date.now()/1000)+offset),id='msg_fixture';const sig=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');return {'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+sig};}
test('Resend sends once with idempotency and exact threading headers, without redirects',async()=>{
 const calls=[];const a=createResendAdapter({sendKey:'fake-send',fetchImpl:async(url,opts)=>{calls.push({url,opts});return response({id:'email-123'});}});
 assert.deepEqual(await a.send(payload,{idempotencyKey:'application-1'}),{id:'email-123',messageId:null});assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].opts.redirect,'error');assert.equal(calls[0].opts.headers['Idempotency-Key'],'application-1');assert.deepEqual(JSON.parse(calls[0].opts.body).headers,payload.headers);
});
test('Resend rejects missing idempotency and header injection before transport',async()=>{
 let calls=0;const a=createResendAdapter({sendKey:'fake',fetchImpl:async()=>{calls++;return response({id:'x'});}});
 await assert.rejects(a.send(payload),/idempotency/i);await assert.rejects(a.send({...payload,subject:'x\r\nBcc: evil@example.com'},{idempotencyKey:'a'}));assert.equal(calls,0);
});
test('provider status and network failures never expose secrets or response body',async()=>{
 for(const fetchImpl of [async()=>new Response('re_SECRET personal body',{status:403}),async()=>{throw Error('re_SECRET');},async()=>response({bad:'re_SECRET'})]){
 const a=createResendAdapter({sendKey:'re_SECRET',fetchImpl});await assert.rejects(a.send(payload,{idempotencyKey:'key'}),e=>!e.message.includes('re_SECRET')&&!e.message.includes('personal body'));
 }
});
test('receiving uses only separate read key and preserves message threading, attachments are metadata',async()=>{
 let call;const a=createResendAdapter({sendKey:'send-only',receiveKey:'read-fake',fetchImpl:async(url,opts)=>{call={url,opts};return response({id:'in-123',from:'Recruiter <recruiter@example.com>',to:['candidate@example.com'],subject:'Interview',text:'Choose a slot.',html:null,message_id:'<incoming@example.com>',headers:{'In-Reply-To':'<parent@example.com>',References:'<parent@example.com>'},attachments:[{id:'att-1',filename:'details.pdf',content_type:'application/pdf',size:1000}],created_at:'2026-10-19T12:00:00Z'});}});
 const m=await a.receive('in-123');assert.equal(call.url,'https://api.resend.com/emails/receiving/in-123?html_format=cid');assert.equal(call.opts.headers.Authorization,'Bearer read-fake');assert.equal(m.transportId,'in-123');assert.equal(m.messageId,'<incoming@example.com>');assert.equal(m.headers['in-reply-to'],'<parent@example.com>');assert.equal(m.attachments[0].downloaded,false);assert.equal(m.attachments[0].name,'details.pdf');assert.equal(m.from,'recruiter@example.com');
 let invoked=false;const b=createResendAdapter({sendKey:'send-only',fetchImpl:async()=>{invoked=true;}});await assert.rejects(b.receive('in-123'),/receiving.*key/i);assert.equal(invoked,false);
});
test('webhook verifies exact raw bytes and rejects tampering, stale/future deliveries and signature floods',()=>{
 const raw=JSON.stringify({type:'email.received',created_at:'2026-10-19T12:00:00Z',data:{email_id:'in-123',to:['candidate@example.com']}}),h=signed(raw);
 const v=verifyResendWebhook(Buffer.from(raw),h,secret);assert.equal(v.id,'msg_fixture');assert.equal(v.event.data.email_id,'in-123');
 assert.throws(()=>verifyResendWebhook(raw+' ',h,secret));for(const offset of [-301,301])assert.throws(()=>verifyResendWebhook(raw,signed(raw,offset),secret));assert.throws(()=>verifyResendWebhook(raw,{...h,'svix-signature':h['svix-signature']+' '.repeat(2000)},secret));
});
test('webhook accepts rotated signatures and standard aliases but rejects conflicting aliases',()=>{
 const raw=JSON.stringify({type:'email.delivered',data:{email_id:'sent-123'}}),h=signed(raw);
 assert.equal(verifyResendWebhook(raw,{...h,'svix-signature':'v1,'+Buffer.alloc(32).toString('base64')+' '+h['svix-signature']},secret).event.type,'email.delivered');
 const alias={'webhook-id':h['svix-id'],'webhook-timestamp':h['svix-timestamp'],'webhook-signature':h['svix-signature']};assert.equal(verifyResendWebhook(raw,alias,secret).id,'msg_fixture');assert.throws(()=>verifyResendWebhook(raw,{...h,...alias,'webhook-id':'different'},secret));
});
test('request deadline bounds a stalled fetch and abort is sanitized',async()=>{
 const a=createResendAdapter({sendKey:'fake',timeoutMs:15,fetchImpl:async()=>new Promise(()=>{})});await assert.rejects(a.send(payload,{idempotencyKey:'timeout'}),/timed out/i);
 const controller=new AbortController();controller.abort(Error('secret-abort'));await assert.rejects(a.send(payload,{idempotencyKey:'abort',signal:controller.signal}),e=>!e.message.includes('secret-abort'));
});
test('provider bodies are bounded, including a response stream stalled after headers',async()=>{
 const stalled=createResendAdapter({sendKey:'fake',timeoutMs:15,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});await assert.rejects(stalled.send(payload,{idempotencyKey:'stalled-body'}),/timed out/i);
 const oversized=createResendAdapter({sendKey:'fake',fetchImpl:async()=>new Response(' '.repeat(1024*1024+1))});await assert.rejects(oversized.send(payload,{idempotencyKey:'oversized'}),/size/i);
});
test('receiving rejects mismatched IDs and header case collisions rather than unsafe thread linking',async()=>{
 const base={id:'in-123',from:'sender@example.com',to:['candidate@example.com'],subject:'Hello',text:'Hi',message_id:'<id@example.com>',created_at:'2026-10-19T12:00:00Z'};
 for(const data of [{...base,id:'other-id'},{...base,headers:{'In-Reply-To':'<one@example.com>','in-reply-to':'<two@example.com>'}},{...base,headers:{'Message-ID':'<different@example.com>'}}]){
  const a=createResendAdapter({receiveKey:'fake-read',fetchImpl:async()=>response(data)});await assert.rejects(a.receive('in-123'),/invalid/i);
 }
});
test('signed malformed or oversized webhook does not become a trusted event',()=>{
 for(const raw of ['[]','null',JSON.stringify({type:'email.received',data:{}})])assert.throws(()=>verifyResendWebhook(raw,signed(raw),secret));
 const huge=' '.repeat(262145);assert.throws(()=>verifyResendWebhook(huge,signed(huge),secret));
});
test('provider rejection does not trigger automatic retries or extra transport calls',async()=>{
 let calls=0;const a=createResendAdapter({sendKey:'fake',fetchImpl:async()=>{calls++;return new Response('',{status:429});}});await assert.rejects(a.send(payload,{idempotencyKey:'stable-key'}));assert.equal(calls,1);
});
test('HTML-only received mail becomes inert labeled plain text with bounded fallback',async()=>{
 const base={id:'in-html',from:'sender@example.com',to:['candidate@example.com'],subject:'Interview',text:null,html:'<style>.hide{}</style><script>steal()</script><p>Please confirm <b>availability</b>.</p><img src="https://tracker.example/open">',message_id:'<html@example.com>',created_at:'2026-10-19T12:00:00Z',attachments:[{id:'attachment-1',filename:'invite.ics',content_type:'text/calendar',size:123}]};
 const a=createResendAdapter({receiveKey:'fake-read',fetchImpl:async()=>response(base)});const m=await a.receive('in-html');assert.match(m.text,/Please confirm availability\s*\./);assert.doesNotMatch(m.text,/steal|hide|tracker|<|>/);assert.equal(m.textSource,'html-extracted');assert.equal(m.textTruncated,false);assert.equal(m.attachments[0].type,'text/calendar');assert.equal(m.attachments[0].downloaded,false);
 const long=createResendAdapter({receiveKey:'fake-read',fetchImpl:async()=>response({...base,html:'<p>'+'A'.repeat(21000)+'</p>'})});const n=await long.receive('in-html');assert.equal(n.text.length,20000);assert.equal(n.textTruncated,true);
});
test('outgoing application snapshots permit up to eighty thousand total text characters',async()=>{
 let body;const a=createResendAdapter({sendKey:'fake',fetchImpl:async(_,opts)=>{body=JSON.parse(opts.body);return response({id:'sent-long'});}});await a.send({...payload,text:'A'.repeat(80000)},{idempotencyKey:'long'});assert.equal(body.text.length,80000);await assert.rejects(a.send({...payload,text:'A'.repeat(80001)},{idempotencyKey:'too-long'}));
});

test('distinct Resend received identities survive a reused sender-chosen Message-ID',async()=>{
 const base={from:'sender@example.com',to:['candidate@example.com'],subject:'Hello',text:'Same message ID',message_id:'<reused@example.com>',created_at:'2026-10-19T12:00:00Z'};
 const a=createResendAdapter({receiveKey:'fake-read',fetchImpl:async url=>response({...base,id:new URL(url).pathname.split('/').at(-1)})});
 const first=await a.receive('provider-one'),second=await a.receive('provider-two');assert.notEqual(first.transportId,second.transportId);assert.equal(first.messageId,second.messageId);
});
