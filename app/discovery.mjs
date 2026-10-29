import {discoverLeverBoard,LEVER_HOSTS} from './lever-discovery.mjs';
import {ashbyVacancyFacts} from './vacancy-source-facts.mjs';
import {canonicalListingUrl,listingIdentity} from './discovery-coverage.mjs';
import {validatePublicUrl} from './network.mjs';
const atsHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com']);
// Ranking only controls the bounded inspection order; it never filters out a profession.
function roleRanker(goals){
 const normalize=value=>String(value??'').toLowerCase().replace(/\bpm\b/g,'product manager').replace(/\bsre\b/g,'site reliability engineer').replace(/\bml\b/g,'machine learning').replace(/[^a-z0-9]+/g,' ').trim();
 const targets=String(goals??'').split(/[,;/|]|\bor\b/i).map(normalize).map(s=>s.replace(/\b(?:junior|senior|lead|staff|principal)\b/g,'').replace(/\s+/g,' ').trim()).filter(Boolean);
 const tokens=[...new Set(targets.flatMap(s=>s.split(' ')).filter(s=>s.length>=3))];
 return title=>{const normalized=` ${normalize(title)} `;return (targets.some(t=>normalized.includes(` ${t} `))?100:0)+tokens.reduce((n,t)=>n+(normalized.includes(` ${t} `)?1:0),0);};
}
export const textFromHtml=html=>html.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
export async function discoverSources(company,{transport,post,signal,profile}){
 const official=new URL(company.homepage).hostname,careerHost=new URL(company.careers).hostname;
 const sameEmployer=u=>[official,careerHost].includes(new URL(u).hostname);
 const atsLinks=[],links=[],feeds=[];let reads=0,failures=0;
 async function read(url){if(reads>=24)throw Error('Discovery resource limit');reads++;const page=await transport(url,{signal});if(new URL(page.url).hostname!==new URL(url).hostname)throw Error('Source changed host');return page;}
 function add(value,base,evidence){try{const u=validatePublicUrl(new URL(value.replaceAll('&amp;','&'),base).href);u.hash='';if(atsHosts.has(u.hostname)){u.search='';u.pathname=u.pathname.replace(/\/$/,'');if(!u.pathname.split('/')[1]||u.pathname.split('/')[1]==='embed')return;if(!atsLinks.some(a=>a.url===u.href))atsLinks.push({url:u.href,linkedFrom:company.careers,evidence});}else if(sameEmployer(u.href)&&/career|\/jobs?(?:\/|$)|positions|openings/i.test(u.pathname))links.push(u.href);}catch{}}
 function embedded(text,base,evidence){const literals=text.replaceAll('\\/','/').replace(/\\u002f/gi,'/');for(const m of literals.matchAll(/https:\/\/jobs\.ashbyhq\.com\/([\w-]+)(?=[/?\"'\\\s<]|$)/gi))add(`https://jobs.ashbyhq.com/${m[1]}`,base,[...evidence,m[0]]);for(const m of text.matchAll(/https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([\w-]+)(?=[?"'`\s<]|$)/gi))add(`https://jobs.ashbyhq.com/${m[1]}`,base,[...evidence,m[0]]);}
 const careers=await read(company.careers);embedded(careers.text,careers.url,[company.careers]);
 for(const m of careers.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi))add(m[1],careers.url,[company.careers]);
 // Follow literal job-feed paths in same-employer scripts; never execute third-party code.
 if(!atsLinks.length){
  const scripts=[...careers.text.matchAll(/<script[^>]*src=["']([^"']+)/gi)].map(m=>{try{return new URL(m[1],careers.url).href;}catch{return null;}}).filter(u=>u&&sameEmployer(u)).slice(0,20);
  for(const url of scripts){if(reads>=22)break;try{const script=await read(url);embedded(script.text,script.url,[company.careers,url]);for(const m of script.text.matchAll(/["'`](\/api\/(?:jobs|careers|positions)(?:\/[\w/-]*)?\/?)["'`]/gi)){const feedUrl=new URL(m[1],careers.url).href;if(!feeds.includes(feedUrl)){feeds.push(feedUrl);const feed=await read(feedUrl);for(const hit of feed.text.matchAll(/https:\/\/[^"\s<>\\]+/g))add(hit[0],feed.url,[company.careers,url,feed.url]);}}}catch{signal?.throwIfAborted();failures++;}}
 }
 const allowed=value=>{try{const u=validatePublicUrl(canonicalListingUrl(value));return sameEmployer(u.href)||atsLinks.some(a=>{const b=new URL(a.url);return u.hostname===b.hostname&&(u.href===b.href||u.pathname.startsWith(b.pathname.replace(/\/$/,'')+'/'));});}catch{return false;}};
 let search={results:[]};try{search=await post('https://api.tavily.com/search',{query:`site:${official} careers jobs ${profile?.goal?.roles??''}`,max_results:20,include_raw_content:false},signal);if(!Array.isArray(search?.results))throw Error('Invalid search response');}catch{signal?.throwIfAborted();failures++;search={results:[]};}
 // Prefer known ATS resources to marketing/navigation; snippets never become job evidence.
 const candidates=[...atsLinks.map(a=>a.url),...links,...(search.results??[]).map(r=>r?.url)].filter(allowed).map(canonicalListingUrl).filter(u=>{const p=new URL(u);if(atsHosts.has(p.hostname))return true;return /career|\/jobs?(?:\/|$)|positions|openings/i.test(p.pathname)&&p.pathname.replace(/\/$/,'')!==new URL(careers.url).pathname.replace(/\/$/,'');});
 const inventory={complete:false,urls:[],sources:[]};let inventoryFailures=0;
 const prepared=new Map(),preparedIdentities=new Set();
 const prepare=(url,job)=>{const identity=listingIdentity(url);if(!preparedIdentities.has(identity)){preparedIdentities.add(identity);prepared.set(url,job);}};
 const ashby=new Map(),loadedAshby=new Set();
 for(const a of atsLinks){const u=new URL(a.url);if(u.hostname==='jobs.ashbyhq.com'){const tenant=u.pathname.split('/')[1];if(tenant&&/^[\w-]+$/.test(tenant))ashby.set(tenant,true);}}
 const rank=roleRanker(profile?.goal?.roles);
 for(const tenant of ashby.keys()){try{const api=`https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;const page=await read(api);const data=JSON.parse(page.text);if(!Array.isArray(data.jobs))throw Error('Invalid job feed');loadedAshby.add(tenant);inventory.sources.push(api);for(const j of (data.jobs??[]).filter(j=>j?.isListed!==false).sort((a,b)=>rank(b?.title)-rank(a?.title))){if(typeof j?.jobUrl!=='string'||!allowed(j.jobUrl)||new URL(j.jobUrl).hostname!=='jobs.ashbyhq.com'||new URL(j.jobUrl).pathname.split('/').filter(Boolean).length!==2||new URL(j.jobUrl).pathname.split('/')[1]!==tenant){inventoryFailures++;failures++;continue;}const jobUrl=canonicalListingUrl(j.jobUrl);inventory.urls.push(jobUrl);const text=j.descriptionPlain||textFromHtml(j.descriptionHtml||'');if(text)prepare(jobUrl,{id:j.id??jobUrl,url:jobUrl,text,title:j.title,location:j.location,facts:ashbyVacancyFacts(j),publishedAt:j.publishedAt,validThrough:j.validThrough,discoveryEvidence:[...(atsLinks.find(a=>a.url===j.jobUrl)?.evidence??[company.careers]),api]});}}catch{signal?.throwIfAborted();failures++;inventoryFailures++;}}
 const greenhouse=new Map();
 for(const a of atsLinks){const u=new URL(a.url);if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(u.hostname)){const tenant=u.pathname.split('/')[1];if(tenant&&/^[\w-]+$/.test(tenant))greenhouse.set(tenant,a);}}
 for(const [tenant,board] of greenhouse){try{const api=`https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=true`;const page=await read(api);const data=JSON.parse(page.text);if(!Array.isArray(data.jobs))throw Error('Invalid board feed');inventory.sources.push(api);
  for(const j of data.jobs.sort((a,b)=>rank(b?.title)-rank(a?.title))){let url;try{url=validatePublicUrl(canonicalListingUrl(j?.absolute_url));}catch{inventoryFailures++;failures++;continue;}if(!['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(url.hostname)||url.pathname.split('/')[1]!==tenant||!/^\/[^/]+\/jobs\/[^/]+$/.test(url.pathname)){inventoryFailures++;failures++;continue;}inventory.urls.push(url.href);if(!j.content)continue;
   const evidence=[...(board.evidence??[company.careers]),board.url,api];add(url.href,company.careers,evidence);prepare(url.href,{id:String(j.id),url:url.href,title:j.title,text:textFromHtml(j.content),location:j.location?.name,facts:{department:j.departments?.[0]?.name},publishedAt:j.first_published,validThrough:j.validThrough,discoveryEvidence:evidence});}
 }catch{signal?.throwIfAborted();failures++;inventoryFailures++;}}
 const lever=new Map();
 for(const board of atsLinks){const u=new URL(board.url);if(LEVER_HOSTS.has(u.hostname)){const tenant=u.pathname.split('/')[1];if(tenant&&/^[\w-]+$/.test(tenant))lever.set(u.hostname+'/'+tenant,board);}}
 const loadedLever=new Set();
 for(const [key,board]of lever){try{const found=await discoverLeverBoard(board,{read,plainText:textFromHtml,rank,signal});inventory.urls.push(...found.urls);inventory.sources.push(...found.sources);if(!found.complete)inventoryFailures++;else loadedLever.add(key);for(const job of found.jobs)prepare(job.url,job);failures+=found.invalid;}catch{signal?.throwIfAborted();failures++;inventoryFailures++;}}
 inventory.urls=[...new Map(inventory.urls.map(url=>[listingIdentity(url),url])).values()];inventory.complete=inventory.sources.length>0&&inventoryFailures===0;
 // Apply the shared budget after ranking across boards, not separately within each board.
 const prioritized=[...prepared.keys()].sort((a,b)=>rank(prepared.get(b).title)-rank(prepared.get(a).title));
 const ordered=[...prioritized,...new Set(candidates)].filter(u=>!loadedAshby.has(new URL(u).pathname.split('/')[1])||prepared.has(u)||new URL(u).hostname!=='jobs.ashbyhq.com');
 // Keep the first (prioritized, prepared) URL when board host aliases share an identity.
 const candidateIdentities=new Map();for(const url of ordered){const identity=listingIdentity(url);if(!candidateIdentities.has(identity))candidateIdentities.set(identity,canonicalListingUrl(url));}
 const allCandidates=[...candidateIdentities.values()].filter(value=>{const u=new URL(value);return !loadedLever.has(u.hostname+'/'+u.pathname.split('/')[1])||prepared.has(value);}).filter(u=>!greenhouse.has(new URL(u).pathname.split('/')[1])||prepared.has(u)||!new URL(u).hostname.includes('greenhouse.io'));
 const unique=allCandidates.slice(0,20);
 return {atsLinks,allowed,prepared,unique,careers,reads,failures,inventory,candidateCount:allCandidates.length};
}

export function isIndividualPosting(page){
 const u=new URL(page.url),parts=u.pathname.split('/').filter(Boolean);
 if(['jobs.ashbyhq.com','jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname))return parts.length>=2;
 if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(u.hostname))return parts.length>=3&&parts[1]==='jobs';
 let count=0,nodes=0;
 function visit(value,depth=0){if(++nodes>20000||depth>32)throw Error('Schema nesting limit');if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}if(value['@type']==='JobPosting'||Array.isArray(value['@type'])&&value['@type'].includes('JobPosting'))count++;for(const [key,item] of Object.entries(value))if(key!=='@type')visit(item,depth+1);}
 try{for(const m of page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){if(!/type\s*=\s*["']application\/ld\+json["']/i.test(m[1]))continue;try{visit(JSON.parse(m[2]));}catch{return false;}}}catch{return false;}
 return count===1;
}
