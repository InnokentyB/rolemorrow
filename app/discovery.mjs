import {validatePublicUrl} from './network.mjs';
const atsHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.ashbyhq.com']);
export const textFromHtml=html=>html.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
export async function discoverSources(company,{transport,post,signal,profile}){
 const official=new URL(company.homepage).hostname,careerHost=new URL(company.careers).hostname;
 const sameEmployer=u=>[official,careerHost].includes(new URL(u).hostname);
 const atsLinks=[],links=[],feeds=[];let reads=0,failures=0;
 async function read(url){if(reads>=24)throw Error('Discovery resource limit');reads++;const page=await transport(url,{signal});if(new URL(page.url).hostname!==new URL(url).hostname)throw Error('Source changed host');return page;}
 function add(value,base,evidence){try{const u=validatePublicUrl(new URL(value.replaceAll('&amp;','&'),base).href);u.hash='';if(atsHosts.has(u.hostname)){if(!u.pathname.split('/')[1]||u.pathname.split('/')[1]==='embed')return;if(!atsLinks.some(a=>a.url===u.href))atsLinks.push({url:u.href,linkedFrom:company.careers,evidence});}else if(sameEmployer(u.href)&&/career|\/jobs?(?:\/|$)|positions|openings/i.test(u.pathname))links.push(u.href);}catch{}}
 function embedded(text,base,evidence){for(const m of text.matchAll(/https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([\w-]+)(?=[?"'`\s<]|$)/gi))add(`https://jobs.ashbyhq.com/${m[1]}`,base,[...evidence,m[0]]);}
 const careers=await read(company.careers);embedded(careers.text,careers.url,[company.careers]);
 for(const m of careers.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi))add(m[1],careers.url,[company.careers]);
 // Follow literal job-feed paths in same-employer scripts; never execute third-party code.
 if(!atsLinks.length){
  const scripts=[...careers.text.matchAll(/<script[^>]*src=["']([^"']+)/gi)].map(m=>{try{return new URL(m[1],careers.url).href;}catch{return null;}}).filter(u=>u&&sameEmployer(u)).slice(0,20);
  for(const url of scripts){if(reads>=22)break;try{const script=await read(url);embedded(script.text,script.url,[company.careers,url]);for(const m of script.text.matchAll(/["'`](\/api\/(?:jobs|careers|positions)(?:\/[\w/-]*)?\/?)["'`]/gi)){const feedUrl=new URL(m[1],careers.url).href;if(!feeds.includes(feedUrl)){feeds.push(feedUrl);const feed=await read(feedUrl);for(const hit of feed.text.matchAll(/https:\/\/[^"\s<>\\]+/g))add(hit[0],feed.url,[company.careers,url,feed.url]);}}}catch{signal?.throwIfAborted();failures++;}}
 }
 const allowed=value=>{try{const u=validatePublicUrl(value);return sameEmployer(u.href)||atsLinks.some(a=>{const b=new URL(a.url);return u.hostname===b.hostname&&(u.href===b.href||u.pathname.startsWith(b.pathname.replace(/\/$/,'')+'/'));});}catch{return false;}};
 const search=await post('https://api.tavily.com/search',{query:`site:${official} careers jobs ${profile?.goal?.roles??''}`,max_results:20,include_raw_content:false},signal);
 // Prefer known ATS resources to marketing/navigation; snippets never become job evidence.
 const candidates=[...atsLinks.map(a=>a.url),...links,...(search.results??[]).map(r=>r.url)].filter(allowed).filter(u=>{const p=new URL(u);if(atsHosts.has(p.hostname))return true;return /career|\/jobs?(?:\/|$)|positions|openings/i.test(p.pathname)&&p.pathname.replace(/\/$/,'')!==new URL(careers.url).pathname.replace(/\/$/,'');});
 const prepared=new Map(),ashby=new Map(),loadedAshby=new Set();
 for(const a of atsLinks){const u=new URL(a.url);if(u.hostname==='jobs.ashbyhq.com'){const tenant=u.pathname.split('/')[1];if(tenant&&/^[\w-]+$/.test(tenant))ashby.set(tenant,true);}}
 const tokens=(profile?.goal?.roles??'').toLowerCase().match(/[a-z]{3,}/g)??[];
 const rank=title=>tokens.reduce((n,t)=>n+(String(title).toLowerCase().includes(t)?1:0),0);
 for(const tenant of ashby.keys()){try{const api=`https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;const page=await read(api);const data=JSON.parse(page.text);if(!Array.isArray(data.jobs))throw Error('Invalid job feed');loadedAshby.add(tenant);for(const j of (data.jobs??[]).filter(j=>j.isListed!==false).sort((a,b)=>rank(b.title)-rank(a.title))){if(typeof j.jobUrl!=='string'||!allowed(j.jobUrl)||new URL(j.jobUrl).pathname.split('/')[1]!==tenant)continue;const text=j.descriptionPlain||textFromHtml(j.descriptionHtml||'');if(text)prepared.set(j.jobUrl,{id:j.id??j.jobUrl,url:j.jobUrl,text,title:j.title,discoveryEvidence:[...(atsLinks.find(a=>a.url===j.jobUrl)?.evidence??[company.careers]),api]});}}catch{signal?.throwIfAborted();failures++;}}
 const greenhouse=new Map();
 for(const a of atsLinks){const u=new URL(a.url);if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(u.hostname)){const tenant=u.pathname.split('/')[1];if(tenant&&/^[\w-]+$/.test(tenant))greenhouse.set(tenant,a);}}
 for(const [tenant,board] of greenhouse){try{const api=`https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=true`;const page=await read(api);const data=JSON.parse(page.text);if(!Array.isArray(data.jobs))throw Error('Invalid board feed');
  for(const j of data.jobs.sort((a,b)=>rank(b.title)-rank(a.title))){let url;try{url=validatePublicUrl(j.absolute_url);}catch{continue;}if(!['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(url.hostname)||url.pathname.split('/')[1]!==tenant||!j.content)continue;
   const evidence=[...(board.evidence??[company.careers]),board.url,api];add(url.href,company.careers,evidence);prepared.set(url.href,{id:String(j.id),url:url.href,title:j.title,text:textFromHtml(j.content),discoveryEvidence:evidence});}
 }catch{signal?.throwIfAborted();failures++;}}
 const ordered=[...prepared.keys(),...new Set(candidates)].filter(u=>!loadedAshby.has(new URL(u).pathname.split('/')[1])||prepared.has(u)||new URL(u).hostname!=='jobs.ashbyhq.com');
 const unique=[...new Set(ordered)].filter(u=>!greenhouse.has(new URL(u).pathname.split('/')[1])||prepared.has(u)||!new URL(u).hostname.includes('greenhouse.io')).slice(0,20);
 return {atsLinks,allowed,prepared,unique,careers,reads,failures};
}

export function isIndividualPosting(page){
 const u=new URL(page.url),parts=u.pathname.split('/').filter(Boolean);
 if(['jobs.ashbyhq.com','jobs.lever.co'].includes(u.hostname))return parts.length>=2;
 if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(u.hostname))return parts.length>=3&&parts[1]==='jobs';
 let count=0,nodes=0;
 function visit(value,depth=0){if(++nodes>20000||depth>32)throw Error('Schema nesting limit');if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}if(value['@type']==='JobPosting'||Array.isArray(value['@type'])&&value['@type'].includes('JobPosting'))count++;for(const [key,item] of Object.entries(value))if(key!=='@type')visit(item,depth+1);}
 try{for(const m of page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){if(!/type\s*=\s*["']application\/ld\+json["']/i.test(m[1]))continue;try{visit(JSON.parse(m[2]));}catch{return false;}}}catch{return false;}
 return count===1;
}
