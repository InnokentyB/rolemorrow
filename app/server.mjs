import {rankResults} from '../public/matching.js';
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProfile,cleanText,hash,id,officialJob,validateJob,validateAssessment,classify,intakeQuestions} from './domain.mjs';
import {getProviders,createFixtureProviders} from './providers.mjs';
import {validatePublicUrl} from './network.mjs';
import {opportunityKey,observe,saveOpportunity,validateDecision} from './opportunities.mjs';
import {mailAction,MailError,publicApplication,publicMessage} from './mail.mjs';
export const EVIDENCE_POLICY='2026-10-18-profession-level-v2';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const blank=()=>({revision:0,profile:null,companies:[],run:null,history:[],opportunities:[],applications:[],messages:[],replyDrafts:[],mailSchema:1});
export function createServer({providers,storeFile=join(process.cwd(),'data','state.json'),env=process.env}={}){
 let state=existsSync(storeFile)?JSON.parse(readFileSync(storeFile,'utf8')):blank();let active=null;
 state.opportunities??=[];state.applications??=[];state.messages??=[];state.replyDrafts??=[];
 function mutate(change){const next=structuredClone(state);change(next);next.revision++;mkdirSync(dirname(storeFile),{recursive:true,mode:0o700});if(existsSync(storeFile)&&!JSON.parse(readFileSync(storeFile,'utf8')).opportunities){try{writeFileSync(storeFile+'.pre-tracking.bak',readFileSync(storeFile),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}if(existsSync(storeFile)&&JSON.parse(readFileSync(storeFile,'utf8')).mailSchema!==1){try{writeFileSync(storeFile+'.pre-mail.bak',readFileSync(storeFile),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}next.mailSchema=1;const serialized=JSON.stringify(next);if(Buffer.byteLength(serialized)>32*1024*1024)throw new MailError(400,'Local workspace storage limit reached (32 MiB).');const tmp=storeFile+'.tmp';writeFileSync(tmp,serialized,{mode:0o600});renameSync(tmp,storeFile);state=next;}
 if(state.run?.status==='running')mutate(s=>{s.run.status='failed';s.run.note='Previous process stopped. Start a new check.';});
 function publicState(){return {...state,opportunities:state.opportunities.map(o=>({...o,assessmentStale:o.snapshot.profileVersion!==state.profile?.version||!!(o.snapshot.assessment&&o.snapshot.evidencePolicy!==EVIDENCE_POLICY)})),applications:state.applications.map(publicApplication),messages:state.messages.map(publicMessage),mailTransport:{mode:'test/manual',liveReady:false,note:'Domain and verified mail provider are not connected. Live sending and reception are disabled.'},run:state.run?{...state.run,stale:state.run.stale||(state.run.mode!=='manual'&&state.run.evidencePolicy!==EVIDENCE_POLICY),results:rankResults(state.run.results).map(r=>({...r,opportunityId:state.opportunities.find(o=>o.identity===opportunityKey(r,state.run.mode))?.id??null}))}:null,history:undefined,config:{liveReady:env.ALLOW_LIVE==='1'&&!!env.NEBIUS_API_KEY&&!!env.TAVILY_API_KEY&&/^nvidia\//.test(env.NEBIUS_MODEL??'')&&(!env.NEBIUS_ASSESSMENT_MODEL||/^nvidia\//.test(env.NEBIUS_ASSESSMENT_MODEL)),modeLabel:'Fictional example · no external requests'},intakeQuestions:intakeQuestions(state.profile)};}
 const stillCurrent=runId=>active?.id===runId&&state.run?.id===runId&&state.run.status==='running';
 async function execute(runId,snapshot,adapter,signal){
  let position=0;
  async function worker(){while(position<snapshot.companies.length&&stillCurrent(runId)){
   const index=position++,company=snapshot.companies[index];
   let coverage={company:company.name,status:'checked',count:0,note:'',checkedAt:new Date().toISOString()};const results=[];
   try{
    const discovered=await adapter.discover(company,{signal,profile:snapshot.profile});if(!Array.isArray(discovered?.jobs))throw Error('Bad discovery result');
    coverage.status=discovered.coverage==='partial'?'partial':'checked';coverage.note=typeof discovered.note==='string'?discovered.note.slice(0,500):'';
    const atsLinks=Array.isArray(discovered.atsLinks)?discovered.atsLinks:[];const seen=new Set();let excluded=0;
    for(const raw of discovered.jobs.slice(0,100)){
     if(!stillCurrent(runId))return;
     let job;try{validatePublicUrl(raw.url);job=validateJob(raw);if(!officialJob(company,job,atsLinks))throw Error('Source not employer verified');}catch{excluded++;continue;}
     const key=company.homepage+'|'+(job.id??job.url);if(seen.has(key))continue;seen.add(key);
     if(results.length===20){coverage.status='partial';coverage.note='20-listing limit reached; additional vacancies not assessed.';break;}
     const result={...job,key,company:company.name,companyIndustry:company.industry??'',source:{url:job.url,hash:hash(job.text),checkedAt:new Date().toISOString(),authority:snapshot.mode==='fixture'?'fictional fixture':'employer source',linkedFrom:company.careers,discoveryEvidence:Array.isArray(raw.discoveryEvidence)?raw.discoveryEvidence.slice(0,8).map(u=>validatePublicUrl(u).href):[]},assessment:null,category:null,error:null,evidencePolicy:EVIDENCE_POLICY,profileVersion:snapshot.profile.version};
     try{const proposed=await adapter.assess(job,snapshot.profile,{signal});const a=validateAssessment(proposed,job,snapshot.profile);Object.assign(result,{assessment:a,...classify(job,a,snapshot.profile,{industry:company.industry})});}catch{result.error='Assessment unavailable: provider failed or evidence did not pass validation. Retry this check.';coverage.status='partial';}
     results.push(result);
    }
    if(excluded){coverage.status='partial';coverage.note=`${excluded} unverified or unusable listings excluded. ${coverage.note}`;}
    if(!results.length&&coverage.status==='checked')coverage.note='No vacancies found in the checked source.';
   }catch{coverage.status='unavailable';coverage.note='Source unavailable. Try the check again; this does not mean there are no vacancies.';}
   coverage.count=results.length;
   if(!stillCurrent(runId))return;
   mutate(s=>{s.run.coverage[index]=coverage;s.run.results.push(...results);for(const result of results){const existing=s.opportunities.find(o=>o.identity===opportunityKey(result,s.run.mode));if(existing)observe(existing,result,s.run);}s.run.completedCompanies++;});
  }}
  try{await Promise.all([worker(),worker()]);if(stillCurrent(runId))mutate(s=>{s.run.status=s.run.coverage.every(c=>c.status==='unavailable')?'failed':s.run.coverage.some(c=>c.status!=='checked')?'partial':'complete';s.run.finishedAt=new Date().toISOString();});}
  catch{if(stillCurrent(runId))try{mutate(s=>{s.run.status='failed';s.run.note='Could not save the check. Retry after checking local storage.';});}catch{active?.controller.abort();}}
 }
 const server=http.createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const host=req.headers.host??'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return send(403,{error:'Local host required.'});
  const origin=`http://${host}`;
  if(req.method!=='GET'&&(req.headers.origin!==origin||!(req.headers['content-type']??'').startsWith('application/json')))return send(403,{error:'Same-origin JSON request required.'});
  const path=new URL(req.url,origin).pathname;
  try{
   if(req.method==='GET'){
    if(path==='/api/state')return send(200,publicState());
    if(path==='/health')return send(200,{ok:true});
    if(path.startsWith('/api/application-files/')||path.startsWith('/api/message-files/')){const [,,group,ownerId,fileId]=path.split('/');const owner=group==='application-files'?state.applications.find(a=>a.opportunityId===ownerId):state.messages.find(m=>m.id===ownerId);const file=owner&&[...owner.files,...(owner.history??[]).flatMap(h=>h.files)].find(f=>f.id===fileId);if(!file)return send(404,{error:'File not found.'});res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${file.name}"`);res.setHeader('Cache-Control','no-store');res.end(Buffer.from(file.base64,'base64'));return;}
    const files={'/':'index.html','/app.js':'app.js','/mail.js':'mail.js','/matching.js':'matching.js','/style.css':'style.css'};
    if(!files[path])return send(404,{error:'Not found.'});const file=files[path];res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(readFileSync(join(publicDir,file)));return;
   }
   let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>((path.startsWith('/api/applications/')||path==='/api/mail/intake')?1048576:64000))return send(413,{error:'Input too large.'});chunks.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return send(400,{error:'Invalid JSON.'});}
   if(body.baseRevision!==undefined&&body.baseRevision!==state.revision)return send(409,{error:'Another window changed this search. Reload before saving.'});
   if((path.startsWith('/api/applications/')||path.startsWith('/api/mail/'))&&req.method==='POST'){mutate(s=>mailAction(s,path,body));return send(200,publicState());}
   if(path==='/api/opportunities'&&req.method==='POST'){
    if(!Number.isInteger(body.baseRevision))return send(400,{error:'Workspace revision required. Reload before saving.'});
    const result=state.run?.results.find(r=>r.key===body.resultKey);if(!result)return send(404,{error:'Result no longer available. Reload Results.'});
    const existing=state.opportunities.find(o=>o.identity===opportunityKey(result,state.run.mode));if(existing)return send(200,publicState());
    if(state.opportunities.length>=500)return send(400,{error:'Saved job limit reached (500).'});
    mutate(s=>saveOpportunity(s,result));return send(200,publicState());
   }
   if(path.startsWith('/api/opportunities/')&&req.method==='POST'){
    const opportunity=state.opportunities.find(o=>o.id===path.slice('/api/opportunities/'.length));if(!opportunity)return send(404,{error:'Saved job not found. Reload saved jobs.'});
    const decision=validateDecision(body);if(body.decisionRevision!==opportunity.decisionRevision)return send(409,{error:'Another window updated this decision. Your draft is kept; reload saved jobs before saving again.'});
    mutate(s=>{const o=s.opportunities.find(v=>v.id===opportunity.id);const now=new Date().toISOString();if(o.stage!==decision.stage)o.events.push({at:now,stage:decision.stage,origin:'candidate'});Object.assign(o,decision,{decisionRevision:o.decisionRevision+1,updatedAt:now});});return send(200,publicState());
   }
   if(path==='/api/profile'&&req.method==='POST'){
    const p=validateProfile(body);active?.controller.abort();active=null;
    mutate(s=>{s.profile={...p,version:hash(p),savedAt:new Date().toISOString()};if(s.run){s.run.stale=true;if(s.run.status==='running')s.run.status='cancelled';}});return send(200,publicState());
   }
   if(path==='/api/companies'&&req.method==='POST'){
    if(!Array.isArray(body.companies)||body.companies.length<1||body.companies.length>5)return send(400,{error:'Choose between one and five companies.'});
    const companies=body.companies.map(c=>{const homepage=validatePublicUrl(c.homepage),careers=validatePublicUrl(c.careers);if(homepage.hostname!==careers.hostname&&!careers.hostname.endsWith('.'+homepage.hostname))throw Error('Careers URL must belong to the official homepage. Linked ATS pages are discovered from there.');const name=cleanText(c.name,100),industry=cleanText(c.industry??'',150);if(!name)throw Error('Add a company name.');return {name,homepage:homepage.href.replace(/\/$/,''),careers:careers.href,industry};});
    if(new Set(companies.map(c=>c.homepage)).size!==companies.length)throw Error('Remove duplicate companies.');active?.controller.abort();active=null;
    mutate(s=>{s.companies=companies;if(s.run){s.run.stale=true;if(s.run.status==='running')s.run.status='cancelled';}});return send(200,publicState());
   }
   if(path==='/api/scans'&&req.method==='POST'){
    if(!state.profile||!state.companies.length)return send(400,{error:'Save your profile, career goal and companies before checking.'});
    if(!['fixture','live'].includes(body.mode))return send(400,{error:'Choose a supported search mode.'});
    if(body.mode==='live'&&(!publicState().config.liveReady||body.consent!==true))return send(403,{error:'Live search is disabled. Server authorization, both keys, NVIDIA model and your data-sharing confirmation are required.'});
    active?.controller.abort();const runId=id(),controller=new AbortController();active={id:runId,controller};
    const snapshot={profile:structuredClone(state.profile),companies:structuredClone(state.companies),mode:body.mode};
    mutate(s=>{if(s.run)s.history=[...s.history,s.run].slice(-5);s.run={id:runId,mode:body.mode,evidencePolicy:EVIDENCE_POLICY,models:body.mode==='live'?{extraction:env.NEBIUS_MODEL,assessment:env.NEBIUS_ASSESSMENT_MODEL||env.NEBIUS_MODEL}:null,status:'running',stale:false,profileVersion:s.profile.version,companyVersion:hash(s.companies),startedAt:new Date().toISOString(),coverage:s.companies.map(c=>({company:c.name,status:'pending',count:0,note:''})),results:[],completedCompanies:0};});
    send(202,publicState());const adapter=providers??(body.mode==='fixture'?createFixtureProviders():getProviders({env}));setImmediate(()=>execute(runId,snapshot,adapter,controller.signal));return;
   }
   if(path==='/api/manual'&&req.method==='POST'){
    if(!state.profile||!state.companies.length)return send(400,{error:'Save your profile and companies first.'});
    if(state.run?.status==='running')return send(409,{error:'Wait for this check to finish, or cancel it before adding text.'});
    const company=state.companies.find(c=>c.name===body.company);if(!company)throw Error('Unknown selected company.');
    const title=cleanText(body.title,250),text=cleanText(body.text,40000),url=validatePublicUrl(body.url).href;if(!title||!text)throw Error('Job title and public description are required.');
    if((state.run?.results.length??0)>=100)return send(400,{error:'Saved listing limit reached. Start a new check.'});
    mutate(s=>{if(!s.run)s.run={id:id(),mode:'manual',status:'partial',stale:false,profileVersion:s.profile.version,companyVersion:hash(s.companies),startedAt:new Date().toISOString(),coverage:[],results:[],completedCompanies:0};s.run.status='partial';const key='manual-'+id();s.run.results.push({id:key,key,title,text,url,company:company.name,requirements:[],countries:[],workMode:'unknown',salary:null,assessment:null,category:null,error:'User-supplied text, unverified. Automated assessment has not run. Review the employer source before relying on this description.',source:{url,hash:hash(text),checkedAt:new Date().toISOString(),authority:'user-supplied unverified',linkedFrom:null},profileVersion:s.profile.version});s.run.coverage.push({company:company.name,status:'unverified',count:1,note:'Manually supplied public description; availability and contents not verified.'});});return send(200,publicState());
   }
   if(path==='/api/cancel'&&req.method==='POST'){active?.controller.abort();active=null;mutate(s=>{if(s.run?.status==='running'){s.run.status='cancelled';s.run.note='Cancelled. Completed results retained; unfinished companies were not checked.';}});return send(200,publicState());}
   if(path==='/api/data'&&req.method==='DELETE'){active?.controller.abort();active=null;mutate(s=>Object.assign(s,blank()));for(const backup of ['.pre-tracking.bak','.pre-mail.bak'])if(existsSync(storeFile+backup))unlinkSync(storeFile+backup);return send(200,publicState());}
   send(404,{error:'Not found.'});
  }catch(error){send(error instanceof MailError?error.status:400,{error:error instanceof MailError?error.message:path==='/api/profile'||path==='/api/companies'||path.startsWith('/api/opportunities')?error.message:'Unable to complete this action. Check your inputs and retry.'});}
 });
 server.on('close',()=>{active?.controller.abort();active=null;});return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const server=createServer();const port=Number(process.env.PORT??3027);server.listen(port,'127.0.0.1',()=>console.log(`Career Search: http://127.0.0.1:${port} (local only)`));
}
