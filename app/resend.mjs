// Official contract: https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/api-reference/emails/retrieve-received-email
// https://resend.com/docs/webhooks/verify-webhooks-requests
// https://docs.svix.com/receiving/verifying-payloads/how-manual
import {textFromHtml} from './discovery.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
export class ResendError extends Error {constructor(message,{status=502,code='resend_failure'}={}){super(message);this.status=status;this.code=code;}}
const fail=(message,status=400)=>{throw new ResendError(message,{status,code:status===400?'invalid_mail':'resend_failure'});};
const str=(value,max,label,{empty=false}={})=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail(`Invalid ${label}.`);return value;};
const line=(value,max,label)=>{str(value,max,label);if(/[\r\n\0]/.test(value))fail(`Invalid ${label}.`);return value;};
const address=value=>{line(value,320,'email address');const plain=value.match(/^[^<>]*<([^<>]+)>$/)?.[1]??value;if(!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(plain))fail('Invalid email address.');return plain.toLowerCase();};
const addresses=value=>{const list=typeof value==='string'?[value]:value;if(!Array.isArray(list)||!list.length||list.length>50)fail('Invalid recipient list.');return list.map(address);};
const providerId=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(value))fail('Invalid provider email ID.');return value;};
const msgId=value=>{line(value,998,'message ID');if(!/^<[^<>\s]+@[^<>\s]+>$/.test(value))fail('Invalid message ID.');return value;};
function sendPayload(input){
 if(!input||typeof input!=='object')fail('Invalid message.');address(input.from);addresses(input.to);line(input.subject,250,'subject');str(input.text,80000,'message body');
 const out={from:input.from,to:input.to,subject:input.subject,text:input.text};
 if(input.reply_to){addresses(input.reply_to);out.reply_to=input.reply_to;}
 if(input.headers!==undefined){if(!input.headers||typeof input.headers!=='object'||Array.isArray(input.headers)||Object.keys(input.headers).length>20)fail('Invalid email headers.');out.headers={};for(const [key,value] of Object.entries(input.headers)){if(!/^[A-Za-z0-9-]{1,80}$/.test(key))fail('Invalid email header.');line(value,2000,'email header');if(!/^(?:in-reply-to|references|message-id|x-rolemorrow-dispatch)$/i.test(key))fail('Unsupported email header.');out.headers[key]=value;}}
 if(input.attachments!==undefined){if(!Array.isArray(input.attachments)||input.attachments.length>2)fail('Invalid attachments.');out.attachments=input.attachments.map(a=>{line(a?.filename,120,'attachment name');if(!/^[A-Za-z0-9 _().-]+$/.test(a.filename)||a.filename.includes('..'))fail('Invalid attachment name.');if(!['application/pdf','text/plain'].includes(a.content_type))fail('Unsupported attachment type.');str(a.content,350000,'attachment content');const bytes=Buffer.from(a.content,'base64');if(!bytes.length||bytes.length>262144||bytes.toString('base64')!==a.content)fail('Invalid attachment content.');return {filename:a.filename,content:a.content,content_type:a.content_type};});}
 return out;
}
async function boundedJson(response){
 if(!response?.ok)throw new ResendError('Mail provider rejected the request.');
 const limit=1024*1024;let bytes=0;const chunks=[];
 if(!response.body?.getReader)throw new ResendError('Invalid mail provider response.');
 const reader=response.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();throw new ResendError('Mail provider response exceeded the supported size.');}chunks.push(value);}}finally{reader.releaseLock();}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ResendError('Invalid mail provider response.');}
}
export function createResendAdapter({sendKey,receiveKey,fetchImpl=globalThis.fetch,timeoutMs=20000}={}){
 const deadline=Math.min(20000,Math.max(1,Number(timeoutMs)||20000));
 async function request(path,key,options,signal){
  if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))throw new ResendError(path.startsWith('/emails/receiving/')?'A separate receiving API key is required (sending-only keys cannot read received mail).':'A sending API key is required.',{status:503});
  if(signal?.aborted)throw new ResendError('Mail request cancelled.');
  const controller=new AbortController();let timer,onAbort;
  const stop=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ResendError('Mail provider request timed out.'));},deadline);onAbort=()=>{controller.abort();reject(new ResendError('Mail request cancelled.'));};signal?.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([stop,(async()=>{const response=await fetchImpl('https://api.resend.com'+path,{...options,headers:{Authorization:'Bearer '+key,...options.headers},redirect:'error',signal:controller.signal});return boundedJson(response);})()]);}
  catch(e){if(e instanceof ResendError)throw e;throw new ResendError('Mail provider request failed.');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 return {
  async send(input,{idempotencyKey,signal}={}){
   if(typeof idempotencyKey!=='string'||! /^[A-Za-z0-9_./:-]{1,256}$/.test(idempotencyKey))fail('A valid idempotency key is required.');const payload=sendPayload(input);
   const result=await request('/emails',sendKey,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(payload)},signal);
   try{return {id:providerId(result.id),messageId:result.message_id?msgId(result.message_id):null};}catch{throw new ResendError('Invalid mail provider response.');}
  },
  async receive(id,{signal}={}){
   providerId(id);const result=await request('/emails/receiving/'+id+'?html_format=cid',receiveKey,{method:'GET',headers:{Accept:'application/json'}},signal);
   try{
    if(providerId(result.id)!==id)fail('Mismatched provider email ID.');const from=address(result.from),to=addresses(result.to),subject=str(result.subject,250,'subject',{empty:true}),plainText=result.text==null?'':str(result.text,500000,'message body',{empty:true}),html=result.html==null?null:str(result.html,500000,'HTML',{empty:true});
    const htmlFallback=!plainText.trim()&&!!html;const normalizedText=htmlFallback?(textFromHtml(html)||'[HTML-only message has no readable text. Review the original email.]'):plainText;const text=normalizedText.slice(0,20000),textSource=htmlFallback?'html-extracted':'plain-text',textTruncated=normalizedText.length>20000;
    const headers={};if(result.headers!==undefined&&(!result.headers||typeof result.headers!=='object'||Array.isArray(result.headers)))fail('Invalid email headers.');
    for(const [name,value] of Object.entries(result.headers??{})){const key=name.toLowerCase();if(['message-id','in-reply-to','references'].includes(key)){line(value,2000,'threading header');if(headers[key]&&headers[key]!==value)fail('Conflicting threading headers.');headers[key]=value;}}
    const messageId=msgId(result.message_id??headers['message-id']);if(headers['message-id']&&headers['message-id']!==messageId)fail('Conflicting message ID.');headers['message-id']=messageId;
    if(result.attachments!==undefined&&(!Array.isArray(result.attachments)||result.attachments.length>100))fail('Invalid attachment metadata.');
    const attachments=(result.attachments??[]).map(a=>({id:providerId(a?.id),name:str(a.filename,255,'attachment filename'),type:line(a.content_type,150,'attachment type'),size:Number.isSafeInteger(a.size)&&a.size>=0?a.size:fail('Invalid attachment size.'),downloaded:false}));
    const createdAt=str(result.created_at,40,'received timestamp');if(!Number.isFinite(Date.parse(createdAt)))fail('Invalid received timestamp.');
    return {providerId:id,transportId:id,messageId,from,fromDisplay:result.from,to,subject,text,textSource,textTruncated,html,headers,inReplyTo:headers['in-reply-to']??'',attachments,files:[],createdAt};
   }catch{throw new ResendError('Received email exceeded supported limits or was invalid.');}
  }
 };
}
export function verifyResendWebhook(rawBody,headers,secret,{now=Date.now()}={}){
 const invalid=()=>{throw new ResendError('Invalid mail webhook.',{status:401,code:'invalid_webhook'});};
 const raw=Buffer.isBuffer(rawBody)?rawBody:typeof rawBody==='string'?Buffer.from(rawBody):invalid();if(raw.length>262144||!raw.length)invalid();
 const get=name=>{if(typeof headers?.get==='function')return headers.get(name);const values=Object.entries(headers??{}).filter(([key])=>key.toLowerCase()===name).map(([,value])=>value);if(values.length>1)invalid();return values[0];};
 const pair=name=>{const a=get('svix-'+name),b=get('webhook-'+name);if(a&&b&&a!==b)invalid();const value=a??b;if(typeof value!=='string')invalid();return value;};
 const id=pair('id'),timestamp=pair('timestamp'),signature=pair('signature');if(!/^[A-Za-z0-9_-]{1,200}$/.test(id)||!/^\d{1,12}$/.test(timestamp)||!Number.isFinite(now)||Math.abs(now/1000-Number(timestamp))>300||signature.length>1024)invalid();
 if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))invalid();const secretBytes=Buffer.from(secret.slice(6),'base64');if(secretBytes.length<16||secretBytes.toString('base64')!==secret.slice(6))invalid();
 const expected=createHmac('sha256',secretBytes).update(id+'.'+timestamp+'.').update(raw).digest();const signatures=signature.trim().split(/\s+/);if(signatures.length>10)invalid();let verified=false;
 for(const part of signatures){const [version,encoded,...extra]=part.split(',');if(version!=='v1'||extra.length||typeof encoded!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(encoded))continue;const actual=Buffer.from(encoded,'base64');if(actual.length===expected.length&&timingSafeEqual(expected,actual))verified=true;}
 if(!verified)invalid();let event;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{invalid();}
 if(!event||typeof event!=='object'||Array.isArray(event)||! /^[a-z][a-z_.]{0,79}$/.test(event.type)||!event.data||typeof event.data!=='object'||Array.isArray(event.data))invalid();
 if(event.type.startsWith('email.')){try{providerId(event.data.email_id);}catch{invalid();}}
 return {id,event};
}
