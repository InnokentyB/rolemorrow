import {schemaVacancyFacts} from './vacancy-source-facts.mjs';
import {safeFetch} from './network.mjs';
import {discoverSources,isIndividualPosting,textFromHtml} from './discovery.mjs';
function matchesRule(pattern,path){
 // Bounded glob matching avoids constructing a regex from an untrusted robots file.
 const exact=pattern.endsWith('$');pattern=pattern.slice(0,exact?-1:undefined)+(exact?'':'*');
 let p=0,i=0,star=-1,retry=0;
 while(i<path.length){if(pattern[p]===path[i]){p++;i++;}else if(pattern[p]==='*'){star=p++;retry=i;}else if(star>=0){p=star+1;i=++retry;}else return false;}
 while(pattern[p]==='*')p++;return p===pattern.length;
}
// A catalog refresh never calls AI/search providers and never reads user profiles.
export function robotsAllowed(body,url){
 const blocks=[];let agents=[],rules=[],seenRule=false;
 const save=()=>{if(agents.length)blocks.push({agents,rules});agents=[];rules=[];seenRule=false;};
 if(String(body).length>65536)throw Error('Robots policy exceeds catalog budget.');
 for(const raw of String(body).split(/\r?\n/)){const line=raw.split('#')[0].trim(),i=line.indexOf(':');if(i<0)continue;const key=line.slice(0,i).trim().toLowerCase(),value=line.slice(i+1).trim();if(value.length>512)throw Error('Robots rule exceeds catalog budget.');if(key==='user-agent'){if(seenRule)save();agents.push(value.toLowerCase());}else if(['allow','disallow'].includes(key)&&agents.length){rules.push({allow:key==='allow',path:value});seenRule=true;}}save();
 const specific=blocks.filter(b=>b.agents.includes('rolemorrowcatalog')),applicable=specific.length?specific:blocks.filter(b=>b.agents.includes('*'));
 const path=new URL(url).pathname+new URL(url).search;let best=null;
 for(const rule of applicable.flatMap(b=>b.rules)){if(!rule.path)continue;if(matchesRule(rule.path,path)&&(!best||rule.path.length>best.path.length||rule.path.length===best.path.length&&rule.allow))best=rule;}
 return best?.allow??true;
}
export function createCatalogTransport({fetchPage=safeFetch,signal,maxRequests=32}={}){
 const robots=new Map(),publicFeedOnly=new Set();let requests=0;
 const bounded=async(url,options)=>{if(++requests>maxRequests)throw Error('Catalog request budget exhausted.');return fetchPage(url,{...options,signal,timeoutMs:10000,maxBytes:1024*1024,headers:{'User-Agent':'RolemorrowCatalog/1.0 (+https://app.rolemorrow.com/privacy)'}});};
 const redirectBudget=()=>{if(++requests>maxRequests)throw Error('Source catalog request budget exhausted.');};
 const authorize=async url=>{signal?.throwIfAborted();const origin=new URL(url).origin;if(!robots.has(origin)){try{const response=await bounded(origin+'/robots.txt',{beforeRedirect:target=>{redirectBudget();if(new URL(target).origin!==origin)throw Error('Source robots changed host.');}});if(new URL(response.url).origin!==origin)throw Error('Source robots changed host.');robots.set(origin,response.text);}catch(error){
 // RFC9309 unavailable robots exception remains restricted to the documented public feed.
 const resource=new URL(url),publicAshbyFeed=resource.hostname==='api.ashbyhq.com'&&/^\/posting-api\/job-board\/[\w-]+$/.test(resource.pathname);if([404,410].includes(error.status))robots.set(origin,'');else if(error.status===401&&publicAshbyFeed){robots.set(origin,'');publicFeedOnly.add(origin);}else throw error;}}if(publicFeedOnly.has(origin)&&!/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/[\w-]+(?:\?|$)/.test(url))throw Error('Source requires public feed scope.');if(!robotsAllowed(robots.get(origin),url))throw Error('Source disallows automated access.');};
 const transport=async url=>{await authorize(url);return bounded(url,{beforeRedirect:async target=>{redirectBudget();await authorize(target);}});};
 return transport;
}
export async function inspectOrganization(company,{fetchPage=safeFetch,signal}={}){
 const transport=createCatalogTransport({fetchPage,signal});
 const result=await discoverSources(company,{transport,signal,profile:null,post:async()=>({results:[]})});
 const postings=[...result.prepared.values()].map(p=>({...p,sources:p.discoveryEvidence}));
 // Generic pages are accepted only with exactly one explicit JobPosting schema.
 for(const url of result.unique.filter(u=>!result.prepared.has(u)).slice(0,5)){try{const page=await transport(url);if(!result.allowed(page.url)||!isIndividualPosting(page))continue;const schema=jobSchema(page.text);if(schema?.title&&schema.description)postings.push({url:page.url,title:schema.title,text:textFromHtml(schema.description),facts:schemaVacancyFacts(schema),location:schemaVacancyFacts(schema).locations.join(' · '),publishedAt:schema.datePosted,validThrough:schema.validThrough,sources:[company.careers,page.url]});}catch{signal?.throwIfAborted();}}
 const openingCount=Math.max(result.inventory.urls.length,postings.length);
 return {postings,inventory:result.inventory,status:openingCount?'openings-observed':result.inventory.complete?'no-openings-observed':'unknown',openingCount,sources:[company.careers,...result.inventory.sources].slice(0,20),ats:result.atsLinks.map(x=>x.url).slice(0,10)};
}
export function createOrganizationRefresh({catalog,vacancies,inspect=inspectOrganization,intervalMs=86400000,batchSize=10,batchIntervalMs=0}={}){
 if(!Number.isInteger(batchIntervalMs)||batchIntervalMs!==0&&batchIntervalMs<3600000)throw Error('Invalid batch interval.');
 if(!Number.isInteger(intervalMs)||intervalMs<3600000||!Number.isInteger(batchSize)||batchSize<1||batchSize>200)throw Error('Invalid catalog refresh limits.');
 let running=null,stopped=false,controller=null;
 function run(){if(stopped)return Promise.resolve({checked:0,stopped:true});if(running)return running;
  controller=new AbortController();const passSignal=controller.signal;
  running=(async()=>{let checked=0,failed=0;const companies=vacancies?catalog.refreshCandidates({vacancies,intervalMs,limit:batchSize}):catalog.due({limit:batchSize,intervalMs});if(companies.length&&batchIntervalMs&&(!vacancies||!await vacancies.claimRefreshBatch(batchIntervalMs)))return {checked:0,failed:0,deferred:true};const nextRefreshAt=vacancies?.refreshBoundary(intervalMs);for(const company of companies){if(stopped)break;try{const signal=AbortSignal.any([passSignal,AbortSignal.timeout(45000)]);const observation=await inspect(company,{signal});if(stopped)break;if(vacancies)await vacancies.observe(company,observation,{nextRefreshAt});await catalog.record(company.id,observation);checked++;}catch{if(stopped)break;if(vacancies)await vacancies.fail(company,{nextRefreshAt});await catalog.record(company.id,{error:'Source unavailable, restricted or outside refresh budget.'});failed++;}}return {checked,failed};})().finally(()=>{running=null;controller=null;});return running;
 }
 return {run,stop(){stopped=true;controller?.abort();}};
}

function jobSchema(html){let found=null,nodes=0;function walk(value,depth=0){if(++nodes>10000||depth>20||!value||typeof value!=='object')return;if(Array.isArray(value)){for(const v of value)walk(v,depth+1);return;}if(value['@type']==='JobPosting'||Array.isArray(value['@type'])&&value['@type'].includes('JobPosting'))found=value;for(const [key,v]of Object.entries(value))if(key!=='@type')walk(v,depth+1);}for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(/type\s*=\s*["']application\/ld\+json["']/i.test(m[1])){try{walk(JSON.parse(m[2]));}catch{}}return found;}
