import test from 'node:test';
import assert from 'node:assert/strict';
import {safeFetch} from '../app/network.mjs';
import {getProviders} from '../app/providers.mjs';
import {profile} from './fixtures.mjs';
const env={ALLOW_LIVE:'1',NEBIUS_API_KEY:'synthetic',TAVILY_API_KEY:'synthetic',NEBIUS_MODEL:'nvidia/test'};
const job={title:'Product Manager',text:'Lead products.',requirements:[{id:'r1',text:'Lead products.',core:true}]};
const answer={direction:'aligned',directionReason:'Same role.',rows:[{requirementId:'r1',status:'unknown',factId:null,profileQuote:null,jobQuote:'Lead products.',unconfirmedQuote:null}]};
const ok=()=>({text:JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]})});
test('AI timeout uses a longer bounded request and one transient retry',async()=>{
 let calls=0;const provider=getProviders({env,transport:async(_url,options)=>{calls++;assert.equal(options.timeoutMs,60000);assert(options.signal);if(calls===1)throw Object.assign(Error('Synthetic timeout'),{code:'SOURCE_TIMEOUT'});return ok();}});
 assert.equal((await provider.assess(job,profile)).rows[0].status,'unknown');assert.equal(calls,2);
});
test('AI retry stops after two attempts and does not retry auth, invalid output or cancellation',async()=>{
 for(const [error,expected] of [[Object.assign(Error('Transient'),{status:503}),2],[Object.assign(Error('Denied'),{status:401}),1],[Error('Invalid output'),1]]){
  let calls=0;const provider=getProviders({env,transport:async()=>{calls++;throw error;}});await assert.rejects(provider.assess(job,profile));assert.equal(calls,expected);
 }
 const controller=new AbortController();let calls=0;const provider=getProviders({env,transport:async()=>{calls++;controller.abort();throw Object.assign(Error('Transient'),{code:'SOURCE_TIMEOUT'});}});await assert.rejects(provider.assess(job,profile,{signal:controller.signal}));assert.equal(calls,1);
});
test('safe fetch exposes safe timeout/status categories and validates configured bounds',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}];
 await assert.rejects(safeFetch('https://example.com',{lookup,timeoutMs:10,transport:async(_u,{signal})=>new Promise((_r,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}),e=>e.code==='SOURCE_TIMEOUT');
 await assert.rejects(safeFetch('https://example.com',{lookup,transport:async()=>new Response('',{status:503})}),e=>e.status===503);
 await assert.rejects(safeFetch('https://example.com',{timeoutMs:Infinity}),/timeout/i);
});
test('semantic review schema makes supported and partial evidence mutually exclusive',async()=>{
 let calls=0;
 const provider=getProviders({env,transport:async(_url,options)=>{
  calls++;const request=JSON.parse(options.body);
  if(calls===1)return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'aligned',directionReason:'Same role.',rows:[{requirementId:'r1',status:'supported',factId:'f1',profileQuote:'AI product evaluation',jobQuote:'AI product evaluation',unconfirmedQuote:null}]})}}]})};
  const variants=request.response_format.json_schema.schema.properties.reviews.items.anyOf;assert.equal(variants.length,2);assert.deepEqual(variants[0].properties.supported.enum,[true]);assert.equal(variants[0].properties.partialEvidence.type,'null');assert.deepEqual(variants[1].properties.supported.enum,[false]);
  return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({reviews:[{requirementId:'r1',reason:'Explicit evidence.',supported:true,partialEvidence:null}]})}}]})};
 }});
 assert.equal((await provider.assess({...job,text:'AI product evaluation',requirements:[{id:'r1',text:'AI product evaluation',core:true}]},profile)).rows[0].status,'supported');assert.equal(calls,2);
});
test('invalid quotation gets one bounded repair, still fails closed when repair is invalid',async()=>{
 for(const repairValid of [true,false]){
  let calls=0;const provider=getProviders({env,transport:async()=>{calls++;const row={...answer.rows[0],jobQuote:calls===1||!repairValid?'Invented quotation':'Lead products.'};return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({...answer,rows:[row]})}}]})};}});
  if(repairValid)assert.equal((await provider.assess(job,profile)).rows[0].status,'unknown');else await assert.rejects(provider.assess(job,profile),/Invalid assessment/);assert.equal(calls,2);
 }
});
test('AI request deadline also classifies a stalled DNS lookup',async()=>{
 await assert.rejects(safeFetch('https://example.com',{timeoutMs:10,lookup:async()=>new Promise(()=>{})}),error=>error.code==='SOURCE_TIMEOUT');
});
test('assessment schema constrains unknown evidence to null and positive quotes to saved facts',async()=>{
 const provider=getProviders({env,transport:async(_url,options)=>{const variants=JSON.parse(options.body).response_format.json_schema.schema.properties.rows.items.anyOf;assert.equal(variants.length,2);const unknown=variants.find(v=>v.properties.status.enum[0]==='unknown'),supported=variants.find(v=>v.properties.status.enum[0]==='supported');assert.equal(unknown.properties.factId.type,'null');assert.equal(unknown.properties.profileQuote.type,'null');assert.deepEqual(unknown.properties.jobQuote.enum,['Lead products.']);assert.deepEqual(supported.properties.profileQuote.enum,profile.facts.map(f=>f.text));return ok();}});await provider.assess(job,profile);
});
test('partial evidence schema only offers disjoint source clauses to assessment and review',async()=>{
 let calls=0;const text='Lead products and manage research.';const provider=getProviders({env,transport:async(_url,options)=>{calls++;const schema=JSON.parse(options.body).response_format.json_schema.schema;const variants=calls===1?schema.properties.rows.items.anyOf:schema.properties.reviews.items.anyOf;const partial=variants.filter(v=>calls===1?v.properties.status.enum[0]==='partial':v.properties.partialEvidence.type==='object');assert.equal(partial.length,2);for(const v of partial){const p=calls===1?v.properties:v.properties.partialEvidence.properties;const q=p.jobQuote.enum[0];assert(text.includes(q));assert(p.unconfirmedQuote.enum.every(m=>text.includes(m)&&m!==q&&!q.includes(m)&&!m.includes(q)));}return {text:JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?{direction:'aligned',directionReason:'Same role.',rows:[{requirementId:'r1',status:'partial',factId:'f1',profileQuote:profile.facts[0].text,jobQuote:'Lead products',unconfirmedQuote:'manage research'}]}:{reviews:[{requirementId:'r1',reason:'Partial explicit evidence.',supported:true,partialEvidence:null}]})}}]})};}});assert.equal((await provider.assess({...job,text,requirements:[{id:'r1',text,core:true}]},profile)).rows[0].status,'partial');
});
