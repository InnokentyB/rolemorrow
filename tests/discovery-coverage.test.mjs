import test from 'node:test';
import assert from 'node:assert/strict';
import {measureDiscovery} from '../app/discovery-coverage.mjs';
import {discoverSources} from '../app/discovery.mjs';
import {coverageNote} from '../app/discovery-coverage.mjs';

test('known inventory uses explicit denominator, deduplicates URLs and counts misses',()=>{
 const m=measureDiscovery({inventory:{complete:true,urls:['https://e.test/jobs/1','https://e.test/jobs/2','https://e.test/jobs/2']},candidateCount:2,inspected:1,returnedUrls:['https://e.test/jobs/1'],failures:0});
 assert.equal(m.knownListings,2);assert.equal(m.returnedKnownListings,1);assert.equal(m.missedKnownListings,1);assert.equal(m.recall,.5);assert.equal(m.truncated,true);
});
test('unknown inventory never invents completeness from zero results or search candidates',()=>{
 const m=measureDiscovery({inventory:{complete:false,urls:[]},candidateCount:0,inspected:0,returnedUrls:[],failures:0});
 assert.equal(m.knownListings,null);assert.equal(m.recall,null);assert.equal(m.status,'unknown');
});
test('known empty board has zero denominator and no percentage',()=>{
 const m=measureDiscovery({inventory:{complete:true,urls:[]},candidateCount:0,inspected:0,returnedUrls:[],failures:0});assert.equal(m.knownListings,0);assert.equal(m.recall,null);assert.match(coverageNote(m),/Employer-wide coverage remains partial/);assert.doesNotMatch(coverageNote(m),/100%|NaN/);
});
test('one failed official board makes the denominator unknown even when another succeeds',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>{
  if(url===company.careers)return {url,text:'<a href="https://jobs.ashbyhq.com/healthy">Jobs</a><a href="https://jobs.ashbyhq.com/broken">More jobs</a>'};
  if(url.includes('/broken'))throw Error('Unavailable fixture board');return {url,text:JSON.stringify({jobs:[]})};
 }});assert.equal(graph.inventory.complete,false);assert.equal(graph.failures,1);
});
test('known-listing recall ignores unexpected results outside the reference inventory',()=>{
 const m=measureDiscovery({inventory:{complete:true,urls:['https://e.test/jobs/1']},candidateCount:2,inspected:2,returnedUrls:['https://e.test/jobs/2'],failures:0});assert.equal(m.recall,0);assert.equal(m.returned,1);assert.equal(m.missedKnownListings,1);
});
test('malformed feed entries prevent a smaller invented known denominator',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/official">Jobs</a>':JSON.stringify({jobs:[{id:'broken',title:'PM',descriptionPlain:'Lead products.'}]})})});
 assert.equal(graph.inventory.complete,false);assert.equal(graph.inventory.urls.length,0);
});
test('a failed linked Lever board prevents calling all linked boards enumerated',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/official">Jobs</a><a href="https://jobs.lever.co/official">Other jobs</a>':JSON.stringify({jobs:[]})})});assert.equal(graph.inventory.complete,false);
});
test('ATS canonical identities ignore tracking and Greenhouse host aliases',()=>{
 const m=measureDiscovery({inventory:{complete:true,urls:['https://boards.greenhouse.io/team/jobs/12?source=a#top','https://job-boards.greenhouse.io/team/jobs/12?source=b']},candidateCount:1,inspected:1,returnedUrls:['https://job-boards.eu.greenhouse.io/team/jobs/12/'],failures:0});
 assert.equal(m.knownListings,1);assert.equal(m.returnedKnownListings,1);assert.equal(m.recall,1);
});
test('a failed search does not discard successfully enumerated official board',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>{throw Error('Search down');},transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/team">Jobs</a>':JSON.stringify({jobs:[{jobUrl:'https://jobs.ashbyhq.com/team/12',descriptionPlain:'Lead products.'}]})})});
 assert.equal(graph.prepared.size,1);assert.equal(graph.failures,1);assert.equal(graph.inventory.complete,true);
});
test('Ashby cannot count employer navigation as an ATS posting or duplicate tracking URLs',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/team">Jobs</a>':JSON.stringify({jobs:[{jobUrl:'https://employer.example/team/navigation',descriptionPlain:'Navigation'},{jobUrl:'https://jobs.ashbyhq.com/team/12?utm_source=a',descriptionPlain:'Lead products.'},{jobUrl:'https://jobs.ashbyhq.com/team/12?utm_source=b',descriptionPlain:'Lead products.'}]})})});
 assert.equal(graph.inventory.complete,false);assert.equal(graph.inventory.urls.length,1);assert.equal(graph.prepared.size,1);
});
test('discovery retains all known Ashby listing identities before the twenty candidate budget',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/official">Jobs</a>':JSON.stringify({jobs:Array.from({length:25},(_,i)=>({id:String(i),jobUrl:`https://jobs.ashbyhq.com/official/${i}`,title:'PM',descriptionPlain:i===24?'':'Lead products.'}))})})});
 assert.equal(graph.inventory.complete,true);assert.equal(graph.inventory.urls.length,25);assert.equal(graph.unique.length,20);assert.equal(graph.candidateCount,24);
});
test('target role on a later linked board survives the shared twenty-candidate budget',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{profile:{goal:{roles:'Product Manager'}},post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/team">Jobs</a><a href="https://boards.greenhouse.io/team">More jobs</a>':url.includes('ashbyhq.com')?JSON.stringify({jobs:Array.from({length:22},(_,i)=>({jobUrl:`https://jobs.ashbyhq.com/team/${i}`,title:'Software Engineer',descriptionPlain:'Build systems.'}))}):JSON.stringify({jobs:[{id:99,absolute_url:'https://boards.greenhouse.io/team/jobs/99',title:'Senior Product Manager',content:'Lead products.'}]})})});
 assert.equal(graph.unique[0],'https://boards.greenhouse.io/team/jobs/99');assert.equal(graph.inventory.urls.length,23);assert.equal(graph.candidateCount,23);
});
test('PM target prioritizes a product manager over incidental product words and avoids substring matches',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const titles=['Product Marketing Manager','Product Engineer','Senior Product Manager','Program Manager'];
 const graph=await discoverSources(company,{profile:{goal:{roles:'PM'}},post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/team">Jobs</a>':JSON.stringify({jobs:titles.map((title,i)=>({jobUrl:`https://jobs.ashbyhq.com/team/${i}`,title,descriptionPlain:'Lead products.'}))})})});
 assert.equal(graph.prepared.get(graph.unique[0]).title,'Senior Product Manager');
});
test('alternative target professions and standard SRE abbreviation receive priority without hiding other roles',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const titles=['Product Marketing Manager','Senior Site Reliability Engineer','Senior Product Designer','Account Executive'];
 const graph=await discoverSources(company,{profile:{goal:{roles:'SRE or Product Designer'}},post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://jobs.ashbyhq.com/team">Jobs</a>':JSON.stringify({jobs:titles.map((title,i)=>({jobUrl:`https://jobs.ashbyhq.com/team/${i}`,title,descriptionPlain:'Build products.'}))})})});
 assert.deepEqual(graph.unique.slice(0,2).map(url=>graph.prepared.get(url).title),titles.slice(1,3));assert.equal(graph.unique.length,4);
});
test('tracking variants of a listing whose Lever feed fails do not consume the candidate budget twice',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[{url:'https://jobs.lever.co/team/one?source=search'}]}),transport:async url=>({url,text:'<a href="https://jobs.lever.co/team/one?source=careers">Role</a>'})});
 assert.equal(graph.candidateCount,1);assert.deepEqual(graph.unique,['https://jobs.lever.co/team/one']);assert.equal(graph.inventory.complete,false);
});
test('a linked Greenhouse host alias cannot overwrite and remove a prepared posting',async()=>{
 const company={homepage:'https://employer.example',careers:'https://employer.example/careers'};
 const graph=await discoverSources(company,{post:async()=>({results:[]}),transport:async url=>({url,text:url===company.careers?'<a href="https://boards.greenhouse.io/team/jobs/12">Role</a>':JSON.stringify({jobs:[{id:12,absolute_url:'https://job-boards.greenhouse.io/team/jobs/12',title:'Product Manager',content:'Lead products.'}]})})});
 assert.deepEqual(graph.unique,['https://job-boards.greenhouse.io/team/jobs/12']);assert.ok(graph.prepared.has(graph.unique[0]));assert.equal(graph.candidateCount,1);
});
