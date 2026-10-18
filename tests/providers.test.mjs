import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePublicUrl,safeFetch} from '../app/network.mjs';
import {getProviders as createProviders,createFixtureProviders} from '../app/providers.mjs';
import {profile,companies} from './fixtures.mjs';
// Named deterministic semantic adapter: these contract tests do not evaluate model judgment.
const getProviders=options=>createProviders({reviewRequirements:async j=>j.requirements.map(r=>r.id),verifyEvidence:async(_j,_p,a)=>a.rows.filter(r=>r.status==='supported').map(r=>r.requirementId),...options});
test('URL validation blocks local, reserved, credentials and mapped addresses',()=>{
 for(const url of ['http://example.com','https://user:pass@example.com','https://localhost','https://127.0.0.1','https://10.0.0.1','https://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://[2001:db8::1]','https://[2001::1]','https://[3fff::1]']) assert.throws(()=>validatePublicUrl(url));
 assert.equal(validatePublicUrl('https://example.com/jobs').hostname,'example.com');
 assert.equal(validatePublicUrl('https://[2606:4700:4700::1111]').protocol,'https:');
});
test('safe fetch validates DNS and redirect before transport',async()=>{
 let calls=0;
 await assert.rejects(safeFetch('https://example.com',{lookup:async()=>[{address:'127.0.0.1',family:4}],transport:async()=>{calls++;}}));
 assert.equal(calls,0);
 await assert.rejects(safeFetch('https://example.com',{lookup:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>{calls++;return new Response('',{status:302,headers:{location:'https://127.0.0.1'}})}}));
 assert.equal(calls,1);
});
test('safe fetch bounds response and returns final evidence',async()=>{
 const opts={lookup:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>new Response('hello')};
 assert.equal((await safeFetch('https://example.com',opts)).text,'hello');
 await assert.rejects(safeFetch('https://example.com',{...opts,maxBytes:2}));
});
test('default providers remain fictional and evidence anchored',async()=>{
 const p=getProviders({env:{}});const d=await p.discover(companies[0]);assert.equal(d.jobs.length,1);
 const a=await p.assess(d.jobs[0],profile);assert.equal(a.rows[0].factId,'f1');
 const f=createFixtureProviders();assert.equal((await f.discover({...companies[0],name:'Fieldwork'})).jobs[0].countries.length,0);
});

test('provider POST never forwards credentials on redirect',async()=>{
 await assert.rejects(safeFetch('https://example.com',{method:'POST',headers:{Authorization:'Bearer synthetic'},lookup:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>new Response('',{status:307,headers:{location:'https://elsewhere.example'}})}),/POST redirect/);
});
const liveEnv={ALLOW_LIVE:'1',NEBIUS_API_KEY:'synthetic-nebius',TAVILY_API_KEY:'synthetic-tavily',NEBIUS_MODEL:'nvidia/configured-model'};
test('live assessment uses exact configured model; malformed and rate errors are safe',async()=>{
 let payload;
 const p=getProviders({env:liveEnv,transport:async(url,opts)=>{payload=JSON.parse(opts.body);return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'uncertain',rows:[]})}}]})};}});
 await p.assess({text:'Untrusted content'},profile);assert.equal(payload.model,liveEnv.NEBIUS_MODEL);
 for(const text of ['not json',JSON.stringify({choices:[]})]){const bad=getProviders({env:liveEnv,transport:async()=>({text})});await assert.rejects(bad.assess({},profile),/malformed JSON|invalid structured/);}
 for(const status of [401,429]) await assert.rejects(safeFetch('https://example.com',{lookup:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>new Response('secret body',{status})}),new RegExp(`^Error: Source request failed \\(${status}\\)\\.$`));
});
test('live discovery accepts literally linked ATS tenant and rejects unrelated tenant',async()=>{
 const fetched=[];
 const p=getProviders({env:liveEnv,transport:async(url,opts={})=>{
  if(url.includes('tavily.com'))return {text:JSON.stringify({results:[{url:'https://jobs.lever.co/unrelated/42'}]})};
  if(url.includes('tokenfactory'))return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{id:'pm',title:'PM',countries:[],workMode:'unknown',salary:null,requirements:[{id:'r1',text:'Lead products.',core:true}]}]})}}]})};
  fetched.push(url);return {url,text:url.endsWith('/careers')?'<a href="https://jobs.lever.co/official/42">PM</a>':'Lead products.'};
 }});
 const result=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});
 assert.ok(!fetched.some(u=>u.includes('unrelated')));assert.ok(fetched.some(u=>u.includes('official')));assert.equal(result.jobs[0].linkedFrom,'https://employer.example/careers');
});
test('fixture rejects arbitrary employers and responds to changed career direction',async()=>{
 const p=createFixtureProviders();await assert.rejects(p.discover({name:'Real',careers:'https://real.example/careers'}),/fictional/);
 const d=await p.discover(companies[0]);assert.equal((await p.assess(d.jobs[0],{...profile,goal:{roles:'Rust Engineer'}})).direction,'different');
});

test('T25 employer script-linked jobs feed discovers roles beyond navigation and retains provenance',async()=>{
 const fetched=[];
 const p=getProviders({env:liveEnv,transport:async(url,opts={})=>{
  fetched.push(url);
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory'))return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{id:'pm',title:'Product Manager',countries:[],workMode:'unknown',salary:null,requirements:[{id:'r1',text:'Lead products.',core:true}]}]})}}]})};
  if(url==='https://employer.example/careers')return {url,text:Array.from({length:30},(_,i)=>`<a href="/menu${i}">Menu</a>`).join('')+'<script src="/careers.js"></script>'};
  if(url==='https://employer.example/careers.js')return {url,text:'fetch("/api/jobs/")'};
  if(url==='https://employer.example/api/jobs/')return {url,text:JSON.stringify([{jobs:[{title:'Product Manager',url:'https://jobs.ashbyhq.com/official/pm'}]}])};
  if(url==='https://api.ashbyhq.com/posting-api/job-board/official?includeCompensation=true')return {url,text:JSON.stringify({jobs:[{id:'pm',title:'Product Manager',jobUrl:'https://jobs.ashbyhq.com/official/pm',descriptionPlain:'Lead products.',isListed:true}]})};
  if(url==='https://jobs.ashbyhq.com/official/pm')return {url,text:'Lead products.'};
  throw Error('unexpected resource');
 }});
 const result=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'},{profile});
 assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].title,'Product Manager');
 assert.ok(!fetched.some(u=>/menu\d/.test(u)));assert.ok(result.atsLinks.some(a=>a.url==='https://jobs.ashbyhq.com/official/pm'));
 assert.ok(result.atsLinks.some(a=>a.evidence?.includes('https://employer.example/api/jobs/')));
});

test('T26 linked Ashby board enumerates listed roles, keeps per-job evidence and rejects foreign tenants',async()=>{
 const p=getProviders({env:liveEnv,transport:async(url,opts={})=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory')){const data=JSON.parse(JSON.parse(opts.body).messages[1].content);assert.equal(data.text,'Lead products.');return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{id:'pm',title:'Product Manager',countries:[],workMode:'unknown',salary:null,requirements:[{id:'r1',text:'Lead products.',core:true}]}]})}}]})};}
  if(url==='https://employer.example/careers')return {url,text:'<a href="https://jobs.ashbyhq.com/official">Open roles</a>'};
  if(url.startsWith('https://api.ashbyhq.com/posting-api/'))return {url,text:JSON.stringify({jobs:[{id:'pm',title:'Product Manager',jobUrl:'https://jobs.ashbyhq.com/official/pm',descriptionPlain:'Lead products.',isListed:true},{id:'closed',title:'Hidden',jobUrl:'https://jobs.ashbyhq.com/official/closed',descriptionPlain:'Hidden',isListed:false},{id:'bad',title:'Foreign',jobUrl:'https://jobs.ashbyhq.com/foreign/pm',descriptionPlain:'Foreign',isListed:true}]})};
  throw Error('unexpected resource');
 }});
 const result=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'},{profile});
 assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].url,'https://jobs.ashbyhq.com/official/pm');assert.equal(result.jobs[0].text,'Lead products.');
});

test('T27 model cannot turn missing profile evidence into a confirmed skill gap',async()=>{
 const p=getProviders({env:liveEnv,transport:async()=>({text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'aligned',directionReason:'Same role',rows:[{requirementId:'r1',status:'gap',factId:null,profileQuote:null,jobQuote:'Own Snowflake.'}]})}}]})})});
 await assert.rejects(p.assess({requirements:[{id:'r1',text:'Own Snowflake.'}]},profile),/Unsupported gap/);
});

test('T28 ATS homepage and external scripts cannot authorize an unrelated tenant',async()=>{
 const fetched=[];const p=getProviders({env:liveEnv,transport:async(url)=>{
  fetched.push(url);if(url.includes('tavily.com'))return {text:'{"results":[{"url":"https://jobs.ashbyhq.com/foreign/pm"}]}'};
  if(url==='https://employer.example/careers')return {url,text:'<a href="https://jobs.ashbyhq.com/">ATS</a><script src="https://foreign.example/jobs.js"></script>'};
  throw Error('unexpected source');
 }});const r=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});
 assert.equal(r.jobs.length,0);assert.equal(r.atsLinks.length,0);assert.ok(!fetched.some(u=>u.includes('foreign')));
});

test('T29 employer-embedded Ashby public API URL establishes only that board',async()=>{
 const {discoverSources}=await import('../app/discovery.mjs');const c={name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(c,{post:async()=>({results:[]}),transport:async(url)=>url===c.careers?{url,text:'<script>var API_URL="https://api.ashbyhq.com/posting-api/job-board/official";</script>'}:{url,text:JSON.stringify({jobs:[{id:'pm',title:'PM',jobUrl:'https://jobs.ashbyhq.com/official/pm',descriptionPlain:'Lead products.',isListed:true}]})}});
 assert.ok(graph.prepared.has('https://jobs.ashbyhq.com/official/pm'));assert.equal(graph.allowed('https://jobs.ashbyhq.com/other/pm'),false);
});

test('T30 Greenhouse legacy board feed retains canonical EU posting URL and rejects other tenants',async()=>{
 const {discoverSources}=await import('../app/discovery.mjs');const c={name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(c,{post:async()=>({results:[]}),transport:async(url)=>{
  if(url===c.careers)return {url,text:'<a href="https://boards.greenhouse.io/official">Jobs</a>'};
  if(url==='https://boards-api.greenhouse.io/v1/boards/official/jobs?content=true')return {url,text:JSON.stringify({jobs:[{id:42,title:'PM',absolute_url:'https://job-boards.eu.greenhouse.io/official/jobs/42',content:'&lt;p&gt;Lead products.&lt;/p&gt;'},{id:99,title:'Foreign',absolute_url:'https://job-boards.eu.greenhouse.io/foreign/jobs/99',content:'Foreign'}]})};throw Error('Unexpected URL');
 }});
 assert.equal(graph.prepared.size,1);assert.equal(graph.prepared.get('https://job-boards.eu.greenhouse.io/official/jobs/42').text,'Lead products.');assert.equal(graph.allowed('https://job-boards.eu.greenhouse.io/foreign/jobs/99'),false);
});

test('T31 search hits on marketing pages never consume the posting-model budget',async()=>{
 let modelCalls=0;const p=getProviders({env:liveEnv,transport:async(url)=>{
  if(url.includes('tavily.com'))return {text:'{"results":[{"url":"https://employer.example/blog/ai"},{"url":"https://employer.example/pricing"}]}'};
  if(url.includes('tokenfactory')){modelCalls++;return {text:'{"choices":[{"message":{"content":"{\\"jobs\\":[]}"}}]}'};}
  return {url,text:'<a href="/careers">Careers</a><a href="/pricing">Pricing</a>'};
 }});const r=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});assert.equal(r.jobs.length,0);assert.equal(modelCalls,0);
});

test('T32 a Product Manager role stays aligned with an explicit PM career goal despite unknown skills',async()=>{
 const p=getProviders({env:liveEnv,transport:async()=>({text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'different',directionReason:'Missing Snowflake evidence.',rows:[]})}}]})})});
 const a=await p.assess({title:'Lead AI Product Manager',requirements:[]},{...profile,goal:{...profile.goal,roles:'Senior Product Manager / Lead PM'}});assert.equal(a.direction,'aligned');
 const b=await p.assess({title:'Rust Engineer',requirements:[]},profile);assert.equal(b.direction,'different');
});

test('T33 requirement references are assigned locally so numeric model labels cannot discard a valid posting',async()=>{
 const {validateJob}=await import('../app/domain.mjs');const p=getProviders({env:liveEnv,transport:async(url)=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory'))return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{id:'pm',title:'PM',countries:[],workMode:'unknown',salary:null,requirements:[{id:1,text:'Lead products.',core:true},{id:1,text:'Own roadmap.',core:false}]}]})}}]})};
  return {url,text:url==='https://employer.example/careers'?'<a href="https://jobs.lever.co/official/pm">PM</a>':'Lead products. Own roadmap.'};
 }});const r=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});assert.doesNotThrow(()=>validateJob(r.jobs[0]));assert.equal(new Set(r.jobs[0].requirements.map(r=>r.id)).size,2);
});

test('T34 prior classifications cannot leak into a fresh assessment request',async()=>{
 let input;const p=getProviders({env:liveEnv,transport:async(url,opts)=>{input=JSON.parse(JSON.parse(opts.body).messages[1].content);return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'uncertain',directionReason:'Needs evidence',rows:[]})}}]})};}});
 await p.assess({title:'PM',text:'Source',requirements:[],assessment:{rows:[{status:'supported'}]},category:'Worth reviewing'},profile);
 assert.equal(input.job.assessment,undefined);assert.equal(input.job.category,undefined);
});

test('T35 a configured NVIDIA assessment model is used and foreign model settings fail before transport',async()=>{
 let selected;const p=getProviders({env:{...liveEnv,NEBIUS_ASSESSMENT_MODEL:'nvidia/stronger-model'},transport:async(url,opts)=>{selected=JSON.parse(opts.body).model;return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'uncertain',directionReason:'Needs evidence',rows:[]})}}]})};}});
 await p.assess({requirements:[]},profile);assert.equal(selected,'nvidia/stronger-model');
 let called=false;const bad=getProviders({env:{...liveEnv,NEBIUS_ASSESSMENT_MODEL:'foreign/model'},transport:async()=>{called=true;}});await assert.rejects(bad.assess({requirements:[]},profile),/NVIDIA/);assert.equal(called,false);
});

test('T36 adjacent platform evidence cannot establish named analytics tools or legacy rebuilding',async()=>{
 const p=getProviders({env:liveEnv,transport:async()=>({text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'aligned',directionReason:'Same role',rows:[{requirementId:'r1',status:'supported',factId:'f1',profileQuote:'API platform launches',jobQuote:'Query Snowflake or Looker yourself.'},{requirementId:'r2',status:'supported',factId:'f1',profileQuote:'API platform launches',jobQuote:'Legacy modernisation: lead incremental rebuilds.'},{requirementId:'r3',status:'supported',factId:'f1',profileQuote:'API platform launches',jobQuote:'Lead API platform launches.'}]})}}]})})});
 const j={title:'Product Manager',requirements:[{id:'r1',text:'Query Snowflake or Looker yourself.'},{id:'r2',text:'Legacy modernisation: lead incremental rebuilds.'},{id:'r3',text:'Lead API platform launches.'}]};const a=await p.assess(j,profile);assert.deepEqual(a.rows.map(r=>r.status),['unknown','unknown','supported']);assert.equal(a.rows[0].factId,null);assert.equal(a.rows[1].profileQuote,null);
});

test('T37 a career department overview is not an individual vacancy; a single JobPosting page is',async()=>{
 for(const structured of [false,true]){let calls=0;const p=getProviders({env:liveEnv,transport:async(url)=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory')){calls++;return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{title:'Sales',countries:[],workMode:'unknown',salary:null,requirements:[{text:'Lead products.',core:true}]}]})}}]})};}
  return {url,text:url.endsWith('/careers')?'<a href="/careers/open-roles">Open roles</a>':(structured?'<script type="application/ld+json">{"@type":"JobPosting","title":"Sales"}</script>':'')+'Sales. Lead products.'};
 }});const r=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});assert.equal(r.jobs.length,structured?1:0);assert.equal(calls,structured?1:0);}
});

test('T38 a model cannot demote requirements to optional without explicit source wording',async()=>{
 const texts=['Query Snowflake or Looker yourself.','Regulated environment. Ideally, experience in fintech.','Technical literacy. Confident with APIs. Ideally, an engineering background.'];
 const p=getProviders({env:liveEnv,transport:async(url)=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory'))return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{title:'PM',countries:[],workMode:'unknown',salary:null,requirements:texts.map(text=>({text,core:false}))}]})}}]})};
  return {url,text:url.endsWith('/careers')?'<a href="https://jobs.lever.co/official/pm">PM</a>':texts.join('\n')};
 }});const r=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});assert.deepEqual(r.jobs[0].requirements.map(r=>r.core),[true,false,true]);
});

test('Q04 extraction preserves optional requirements even without a prefix',async()=>{
 const p=getProviders({env:liveEnv,transport:async(url)=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory'))return {text:JSON.stringify({choices:[{message:{content:JSON.stringify({jobs:[{title:'Product Manager',countries:[],workMode:'unknown',salary:null,requirements:[{text:'Lead products.',core:true},{text:'Experience with Rust is a plus.',core:false}]}]})}}]})};
  return {url,text:url.endsWith('/careers')?'<a href="https://jobs.lever.co/official/42">PM</a>':'Lead products. Experience with Rust is a plus.'};
 }});
 const result=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});
 assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].requirements[1].core,false);
});

test('Q05 public IPv4-mapped DNS answers are normalized; mapped private answers stay blocked',async()=>{
 const publicAnswers=[{address:'93.184.216.34',family:4},{address:'::ffff:93.184.216.34',family:6}];let calls=0;
 const result=await safeFetch('https://example.com',{lookup:async()=>publicAnswers,transport:async()=>{calls++;return new Response('public');}});
 assert.equal(result.text,'public');assert.equal(calls,1);
 for(const address of ['::ffff:127.0.0.1','::ffff:10.0.0.1','::ffff:169.254.169.254','::ffff:100.64.0.1','::ffff:7f00:1']){
  await assert.rejects(safeFetch('https://example.com',{lookup:async()=>[...publicAnswers,{address,family:6}],transport:async()=>{calls++;return new Response('unsafe');}}),/Unsafe source DNS/);
 }
 assert.equal(calls,1);assert.throws(()=>validatePublicUrl('https://[::ffff:93.184.216.34]'),/Unsafe/);
});

test('Q06 an exact quote about APIs cannot prove an unmentioned minimum duration',async()=>{
 const requirement='3+ years of product management experience shipping APIs.';
 const j={title:'Product Manager',requirements:[{id:'r1',text:requirement,core:true}]};
 for(const [quote,status] of [['Led enterprise API integration onboarding.','unknown'],['2 years of product management shipping APIs.','unknown'],['4 years of product management shipping APIs.','supported']]){
  const p=getProviders({env:liveEnv,transport:async()=>({text:JSON.stringify({choices:[{message:{content:JSON.stringify({direction:'aligned',directionReason:'Same role',rows:[{requirementId:'r1',status:'supported',factId:'duration',profileQuote:quote,jobQuote:requirement}]})}}]})})});
  const a=await p.assess(j,{...profile,facts:[{id:'duration',text:quote}]});
  assert.equal(a.rows[0].status,status);if(status==='unknown')assert.equal(a.rows[0].factId,null);
 }
});


test('Q07 independent verification can downgrade an exact but non-entailing quote',async()=>{
 let calls=0;const requirement='Write UX research reports.';
 const p=createProviders({env:liveEnv,transport:async()=>{calls++;const content=calls===1?{direction:'aligned',directionReason:'Same role',rows:[{requirementId:'r1',status:'supported',factId:'f1',profileQuote:'Personally wrote SQL queries.',jobQuote:requirement}]}:{supportedIds:[]};return {text:JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]})};}});
 const a=await p.assess({title:'Product Manager',requirements:[{id:'r1',text:requirement,core:true}]},{...profile,facts:[{id:'f1',text:'Personally wrote SQL queries.'}]});
 assert.equal(calls,2);assert.equal(a.rows[0].status,'unknown');assert.equal(a.rows[0].profileQuote,null);
});
test('Q08 requirement review excludes perks and duplicate source clauses before assessment',async()=>{
 const p=createProviders({env:liveEnv,transport:async(url,opts={})=>{
  if(url.includes('tavily.com'))return {text:'{"results":[]}'};
  if(url.includes('tokenfactory')){const payload=JSON.parse(opts.body);const review=payload.messages[0].content.includes('Review extracted requirements');const content=review?{keepIds:['r1']}:{jobs:[{title:'Product Manager',countries:[],workMode:'unknown',salary:null,requirements:[{text:'Lead products.',core:true},{text:'Company-sponsored health coverage.',core:true},{text:'Lead products.',core:true}]}]};return {text:JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]})};}
  return {url,text:url.endsWith('/careers')?'<a href="https://jobs.lever.co/official/42">PM</a>':'Lead products. Company-sponsored health coverage.'};
 }});const result=await p.discover({name:'Real',homepage:'https://employer.example',careers:'https://employer.example/careers'});
 assert.equal(result.jobs.length,1);assert.deepEqual(result.jobs[0].requirements.map(r=>r.text),['Lead products.']);
});

test('Q09 failed or fabricated verification cannot publish supported claims',async()=>{
 for(const verification of [{supportedIds:['r1']},{supportedIds:['invented']},{notTheContract:[]}]){
  let calls=0;const requirement='Lead AI product evaluation.';
  const p=createProviders({env:liveEnv,transport:async()=>{calls++;return {text:JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?{direction:'aligned',directionReason:'Same role',rows:[{requirementId:'r1',status:'supported',factId:'f1',profileQuote:'AI product evaluation',jobQuote:requirement}]}:verification)}}]})};}});
  const request=p.assess({title:'Product Manager',requirements:[{id:'r1',text:requirement,core:true}]},profile);
  if(verification.supportedIds?.[0]==='r1')assert.equal((await request).rows[0].status,'supported');else await assert.rejects(request,/Invalid semantic review/);
 }
});
