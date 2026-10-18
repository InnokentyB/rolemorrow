import {chromium} from './browser.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from '../app/server.mjs';import {getProviders} from '../app/providers.mjs';
const dir=await mkdtemp(join(tmpdir(),'career-ats-'));
const env={ALLOW_LIVE:'1',NEBIUS_API_KEY:'test-only',TAVILY_API_KEY:'test-only',NEBIUS_MODEL:'nvidia/test-only'};
// Named deterministic semantic-review adapter; real model quality is tested separately.
const adapter=getProviders({env,reviewRequirements:async j=>j.requirements.map(r=>r.id),verifyEvidence:async(_j,_p,a)=>a.rows.filter(r=>['supported','partial'].includes(r.status)).map(r=>r.requirementId),transport:async(url,opts={})=>{
 if(url.includes('tavily.com'))return {text:'{"results":[]}'};
 if(url.includes('tokenfactory')){const extraction=JSON.parse(opts.body).messages[0].content.includes('Extract');return {text:JSON.stringify({choices:[{message:{content:JSON.stringify(extraction?{jobs:[{id:'pm',title:'Lead AI Product Manager',countries:['Portugal'],workMode:'remote',salary:null,requirements:[{id:'r1',text:'Lead AI product evaluation.',core:true}]}]}:{direction:'aligned',directionReason:'Matches Product Manager goal.',rows:[{requirementId:'r1',status:'supported',factId:'f1',profileQuote:'AI product evaluation',jobQuote:'Lead AI product evaluation.'}]})}}]})};}
 if(url==='https://employer.example/careers')return {url,text:'<script src="/careers.js"></script>'};
 if(url.endsWith('careers.js'))return {url,text:'fetch("/api/jobs/")'};
 if(url==='https://employer.example/api/jobs/')return {url,text:'[{"url":"https://jobs.ashbyhq.com/official/pm"}]'};
 if(url.startsWith('https://api.ashbyhq.com/posting-api/'))return {url,text:JSON.stringify({jobs:[{title:'Lead AI Product Manager',jobUrl:'https://jobs.ashbyhq.com/official/pm',descriptionPlain:'Lead AI product evaluation. Remote in Portugal.',isListed:true}]})};
 throw Error('Unexpected request');
}});
const server=createServer({providers:adapter,env,storeFile:join(dir,'state.json')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
try{const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Use fictional example',exact:true}).click();await page.getByLabel('Company sources').fill('Real Employer | https://employer.example | https://employer.example/careers | AI');await page.getByRole('button',{name:'Save companies',exact:true}).click();await page.getByLabel('Search mode').selectOption('live');await page.locator('#consent').check();await page.getByRole('button',{name:'Check selected companies',exact:true}).click();await page.getByRole('heading',{name:'Lead AI Product Manager',exact:true}).waitFor();await page.getByText('Review evidence',{exact:true}).click();await page.getByText('AI product evaluation',{exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Lead AI Product Manager',exact:true}).waitFor();const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));assert.equal(saved.run.mode,'live');assert.equal(saved.run.results[0].source.authority,'employer source');assert.equal(saved.run.results[0].source.url,'https://jobs.ashbyhq.com/official/pm');assert.equal(saved.run.results[0].assessment.rows[0].factId,'f1');console.log('T25/T26 browser: employer feed → ATS → extraction → profile evidence → persisted result PASS');}finally{await browser.close();await new Promise(r=>server.close(r));}
