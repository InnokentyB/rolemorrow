import {validatePublicUrl,safeFetch} from './network.mjs';import {organizationDomain,organizationSeed} from './organizations.mjs';import {createCatalogTransport} from './organization-refresh.mjs';
const normalized=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").trim();
function publicName(html,domain){
 for(const tag of html.match(/<meta\b[^>]{0,2000}>/gi)??[]){const attr=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));if((attr.property??attr.name)?.toLowerCase()==='og:site_name'&&attr.content){const value=decode(attr.content).slice(0,100),first=value.split(/ [|–—-] /)[0];return normalized(first)===normalized(domain.split('.')[0])?first:value;}}
 return domain;
}
export async function verifyOrganizationCandidate(candidate,{signal,fetchPage=safeFetch,search}={}){
 const transport=createCatalogTransport({fetchPage,signal,maxRequests:16});let choices=[];
 if(candidate.homepage)choices=[candidate];else{if(!search)return null;const hits=await search(candidate.query,{signal});for(const hit of hits.slice(0,5)){try{const u=validatePublicUrl(hit.url);const home=new URL(u.origin);home.hostname=home.hostname.replace(/^(?:careers|jobs)\./,'');organizationDomain(home.origin);if(!choices.some(x=>organizationDomain(x.homepage)===organizationDomain(home.origin)))choices.push({homepage:home.origin,priority:u.pathname==='/'?0:1});}catch{}}}
 const verified=[];
 for(const choice of choices.sort((a,b)=>(a.priority??0)-(b.priority??0)).slice(0,5)){try{const domain=organizationDomain(choice.homepage),page=await transport(choice.homepage);if(organizationDomain(new URL(page.url).origin)!==domain)continue;const name=publicName(page.text,domain);
  if(candidate.query&&![normalized(name),normalized(domain.split('.')[0])].includes(normalized(candidate.query)))continue;
  const links=[];for(const match of page.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){try{const u=validatePublicUrl(new URL(decode(match[1]),page.url).href);if(u.hostname.replace(/^www\./,'')!==domain&&!u.hostname.endsWith('.'+domain))continue;if(!/career|\/jobs?\b|work-with|join-us|\/journey\b/i.test(u.hostname+u.pathname))continue;u.hash='';u.search='';if(!links.includes(u.href))links.push(u.href);}catch{}}
  const equivalent=(a,b)=>new URL(a).origin.replace('://www.','://')+new URL(a).pathname.replace(/\/$/,'')===new URL(b).origin.replace('://www.','://')+new URL(b).pathname.replace(/\/$/,'');
  const careers=choice.careers?links.find(url=>equivalent(url,choice.careers)):links[0];if(!careers)continue;
  const careerPage=await transport(careers);const final=validatePublicUrl(careerPage.url);if(final.hostname.replace(/^www\./,'')!==domain&&!final.hostname.endsWith('.'+domain))continue;
  verified.push({...organizationSeed({name,homepage:choice.homepage,careers:final.href}),provenance:{kind:'public-website-linked-careers',url:page.url,careersUrl:final.href}});
 }catch{signal?.throwIfAborted();}}
 return verified.length===1?verified[0]:null;
}
export function organizationSearch(env){if(!env.TAVILY_API_KEY||env.ORGANIZATION_DISCOVERY_ENABLED!=='1')return undefined;return async(query,{signal}={})=>{
 const response=await safeFetch('https://api.tavily.com/search',{signal,method:'POST',headers:{Authorization:'Bearer '+env.TAVILY_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query:query+' official website',search_depth:'basic',max_results:5,include_answer:false,include_raw_content:false,auto_parameters:false}),timeoutMs:12000,maxBytes:131072});const data=JSON.parse(response.text);return Array.isArray(data.results)?data.results:[];
};}
