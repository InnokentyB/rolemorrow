import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../app/server.mjs';
test('URL intake saves without profile, network or scan; canonical duplicates preserve decisions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'url-intake-'));let reads=0;
 const server=createServer({storeFile:join(dir,'state.json'),env:{ALLOW_LIVE:'1'},providers:{readExternal:async url=>{reads++;return {url,text:'<title>Product Manager</title><p>Build tools for customers and collaborate with engineering on product strategy.</p>'};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(body)=>{const response=await fetch(base+'/api/intake/url',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 let r=await call({url:'https://employer.example/jobs/42?utm_source=board',baseRevision:0});assert.equal(r.status,200);assert.equal(reads,0);assert.equal(r.data.run,null);assert.equal(r.data.opportunities.length,1);assert.equal(r.data.opportunities[0].snapshot.assessment,null);assert.equal(r.data.opportunities[0].snapshot.source.authority,'user-supplied unverified');
 const saved=r.data.opportunities[0];const decision=await fetch(base+'/api/opportunities/'+saved.id,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({decisionRevision:0,stage:'interview',note:'Keep my notes',nextAction:'Ask recruiter',dueDate:''})});r.data=await decision.json();
 r=await call({url:'https://employer.example/jobs/42#apply',baseRevision:r.data.revision});assert.equal(r.status,200);assert.equal(r.data.opportunities.length,1);assert.equal(r.data.opportunities[0].note,'Keep my notes');assert.equal(r.data.opportunities[0].stage,'interview');
 assert.equal((await call({url:'https://employer.example/jobs/oversized',title:'x'.repeat(251),baseRevision:r.data.revision})).status,400);
 assert.equal((await call({url:'http://localhost/x',baseRevision:r.data.revision})).status,400);
 assert.equal((await call({url:'https://employer.example/jobs/new',readSource:true,baseRevision:r.data.revision})).status,403);assert.equal(reads,0);
 r=await call({url:'https://employer.example/jobs/new',readSource:true,consent:true,baseRevision:r.data.revision});assert.equal(r.status,200);assert.equal(reads,1);assert.equal(r.data.opportunities.at(-1).snapshot.title,'Product Manager');assert.equal(r.data.opportunities.at(-1).snapshot.source.authority,'user-supplied unverified');
});

test('URL intake cannot recreate deleted data after an in-flight page read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'url-intake-race-'));let release,entered;
 const started=new Promise(r=>entered=r);
 const server=createServer({storeFile:join(dir,'state.json'),env:{ALLOW_LIVE:'1'},providers:{readExternal:async url=>{entered();await new Promise(r=>release=r);return {url,text:'<title>Product Manager</title><p>Own product strategy and build tools with engineering and customers.</p>'};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body,method='POST')=>{const response=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
 const first=await call('/api/intake/url',{url:'https://employer.example/jobs/first',baseRevision:0});assert.equal(first.data.revision,1);
 const pending=call('/api/intake/url',{url:'https://employer.example/jobs/racing',readSource:true,consent:true,baseRevision:1});await started;
 const deleted=await call('/api/data',{},'DELETE');assert.equal(deleted.status,200);release();
 assert.equal((await pending).status,409);
 const fresh=await(await fetch(base+'/api/state')).json();assert.equal(fresh.opportunities.length,0);assert.equal(fresh.run,null);
});

import {writeFile,readFile} from 'node:fs/promises';
import {externalListing} from '../app/url-intake.mjs';
import {saveOpportunity} from '../app/opportunities.mjs';
test('URL duplicate cannot overwrite verified snapshot, decision or existing scan',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'url-intake-existing-')),file=join(dir,'state.json');
 const result=await externalListing({url:'https://ats.example/jobs/42',title:'Verified title',text:'Confirmed description'});
 result.source={...result.source,authority:'employer source',linkedFrom:'https://employer.example/careers'};
 result.assessment={existing:'preserve'};
 const seed={revision:7,profile:null,companies:[],run:{id:'old-scan',mode:'live',status:'complete',results:[],coverage:[],startedAt:new Date().toISOString()},history:[],mailSchema:1,opportunities:[],applications:[],messages:[],replyDrafts:[]};
 const saved=saveOpportunity(seed,result);saved.stage='interview';saved.note='Recruiter confirmed';saved.nextAction='Choose date';saved.decisionRevision=3;
 await writeFile(file,JSON.stringify(seed));
 let reads=0;const server=createServer({storeFile:file,env:{},providers:{readExternal:async()=>{reads++;throw Error('Forbidden');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=async body=>{const r=await fetch(base+'/api/intake/url',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const before=await readFile(file,'utf8');
 const duplicate=await post({url:'https://ats.example/jobs/42/?utm_source=board#apply',title:'Wrong replacement',text:'Unverified replacement',baseRevision:7});assert.equal(duplicate.status,200);assert.equal(duplicate.data.opportunities.length,1);assert.deepEqual(duplicate.data.opportunities[0].snapshot,result);assert.equal(duplicate.data.opportunities[0].note,'Recruiter confirmed');assert.equal(duplicate.data.opportunities[0].decisionRevision,3);assert.equal(await readFile(file,'utf8'),before);
 assert.equal((await post({url:'https://ats.example/jobs/43',readSource:true,consent:true,baseRevision:7})).status,403);assert.equal(reads,0);
 const added=await post({url:'https://ats.example/jobs/43',baseRevision:7});assert.equal(added.status,200);assert.deepEqual(added.data.run.results,seed.run.results);assert.equal(added.data.run.id,'old-scan');assert.equal(added.data.run.status,'complete');
});

test('URL reading preserves supplied text; redirects, access pages and failures yield honest saved-link fallback',async()=>{
 const url='https://employer.example/jobs/42';
 for(const page of [{url:'https://elsewhere.example/jobs/42',text:'<title>Unrelated</title>Available text that must never replace saved description.'},{url:'https://employer.example/jobs',text:'<title>Jobs</title>Other jobs that must never replace saved description.'},{url,text:'<p>Checking your browser; verify you are human to access the job description.</p>'},null]){
  const result=await externalListing({url,readSource:true},{read:async()=>{if(!page)throw Error('Private service internals');return page;}});
  assert.equal(result.title,'Saved vacancy link');assert.equal(result.text,'');assert.match(result.error,/Page could not be read/);assert.doesNotMatch(result.error,/Private service internals/);assert.equal(result.assessment,null);
 }
 const supplied=await externalListing({url,title:'Chosen title',text:'User text',readSource:true},{read:async()=>({url,text:'<title>Retrieved title</title><p>Retrieved requirements sufficiently long to read this public page.</p>'})});
 assert.equal(supplied.title,'Chosen title');assert.equal(supplied.text,'User text');assert.equal(supplied.source.authority,'user-supplied unverified');
});
