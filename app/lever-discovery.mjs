import {validatePublicUrl} from './network.mjs';import {canonicalListingUrl,listingIdentity} from './discovery-coverage.mjs';
import {leverVacancyFacts} from './vacancy-source-facts.mjs';
export const LEVER_HOSTS=new Set(['jobs.lever.co','jobs.eu.lever.co']);
// Read-only public API. Each board is authorized by an actual employer-page link.
export async function discoverLeverBoard(board,{read,plainText,rank=()=>0,signal}={}){
 const url=new URL(board.url),tenant=url.pathname.split('/')[1];if(!LEVER_HOSTS.has(url.hostname)||!tenant||! /^[\w-]+$/.test(tenant))throw Error('Invalid linked Lever board.');
 const source=`https://${url.hostname==='jobs.eu.lever.co'?'api.eu.lever.co':'api.lever.co'}/v0/postings/${tenant}?mode=json`;
 const jobs=[],urls=[],seen=new Set();let complete=false,invalid=0;
 for(let page=0;page<5;page++){
  signal?.throwIfAborted();let rows;try{const response=await read(source+'&limit=100&skip='+page*100);rows=JSON.parse(response.text);if(!Array.isArray(rows)||rows.length>100)throw Error('Invalid public Lever page.');}catch(error){signal?.throwIfAborted();if(page===0)throw error;break;}let newEntries=0;
  for(const job of rows){let posting;try{posting=validatePublicUrl(canonicalListingUrl(job?.hostedUrl));}catch{invalid++;continue;}const path=posting.pathname.split('/').filter(Boolean);if(posting.hostname!==url.hostname||path.length!==2||path[0]!==tenant||typeof job.id!=='string'||path[1]!==job.id){invalid++;continue;}
   const identity=listingIdentity(posting.href);if(seen.has(identity)){invalid++;continue;}seen.add(identity);newEntries++;urls.push(posting.href);
   const description=[job.descriptionPlain||(typeof job.description==='string'?plainText(job.description):''),...(Array.isArray(job.lists)?job.lists.slice(0,30):[]).map(item=>[typeof item?.text==='string'?item.text:'',typeof item?.content==='string'?plainText(item.content):''].filter(Boolean).join('\n')),job.additionalPlain||(typeof job.additional==='string'?plainText(job.additional):'')].filter(x=>typeof x==='string'&&x.trim()).join('\n\n');
   if(description)jobs.push({id:job.id,url:posting.href,title:job.text,text:description,location:job.categories?.location,facts:leverVacancyFacts(job),discoveryEvidence:[...(board.evidence??[]),board.url,source]});
  }
  if(rows.length<100){complete=invalid===0;break;}if(!newEntries)break;
 }
 return {jobs:jobs.sort((a,b)=>rank(b.title)-rank(a.title)),urls,sources:[source],complete,invalid};
}
