import {openCatalogDatabase} from './catalog-database.mjs';
import {textPredicate,pageOffset,pageSize} from './catalog-query.mjs';
// Shared public employer identities. User suggestions require independent public-source verification.
import {createHash} from 'node:crypto';
import {validatePublicUrl} from './network.mjs';
import {INDUSTRIES,EMPLOYEE_RANGES,classifyIndustry,employeeEvidence} from './organization-classification.mjs';
export const ORGANIZATION_MAX_AGE=7*86400000;
const sharedHosts=['greenhouse.io','lever.co','ashbyhq.com','workable.com','linkedin.com','github.io','notion.site','myworkdayjobs.com'];
const text=(v,n)=>String(v??'').replace(/[\x00-\x1f|]/g,' ').trim().slice(0,n);
export function organizationDomain(value){const u=validatePublicUrl(value);if(u.search||u.hash||!['','/'].includes(u.pathname))throw Error('Use the company homepage origin.');const h=u.hostname.replace(/^www\./,'');if(sharedHosts.some(x=>h===x||h.endsWith('.'+x)))throw Error('An ATS or shared host is not an employer identity.');return h;}
export function organizationSeed(input){
 const domain=organizationDomain(input.homepage),homepage=validatePublicUrl(input.homepage).origin;
 const careers=validatePublicUrl(input.careers);if(careers.hostname.replace(/^www\./,'')!==domain&&!careers.hostname.endsWith('.'+domain))throw Error('Careers must start on the employer domain.');
 careers.hash='';careers.search='';const name=text(input.name,100);if(!name)throw Error('Company name required.');
 return {id:'org-'+createHash('sha256').update(domain).digest('hex').slice(0,24),domain,name,homepage,careers:careers.href,industry:text(input.industry,150),industryGroup:classifyIndustry(input.industry),employees:employeeEvidence(input.employees,validatePublicUrl),provenance:{kind:'operator-reviewed-public-source',url:careers.href}};
}
export async function createOrganizationCatalog({file,now=()=>Date.now(),database}={}){
 const owned=!database;if(!database&&!file)throw Error('A catalog file or database is required.');database??=await openCatalogDatabase({file:file+'.sqlite',organizationsFile:file});
 const decode=row=>JSON.parse(row.data);
 function size(row){return row.employees&&now()-Date.parse(row.employees.asOf)<=365*86400000?row.employees.range:'unknown';}
 function view(row){const stale=!row.checkedAt||now()-row.checkedAt>=ORGANIZATION_MAX_AGE;return {...row,industryGroup:row.industryGroup??classifyIndustry(row.industry),employeeSize:size(row),stale,hiring:stale||row.lastError?'unknown':row.observation?.status??'unknown'};}
 function filters({query='',industry='',employeeSize=''}={}){const predicate=textPredicate('organization_search','o','search_text',query),sql=[predicate.sql],args=[...predicate.args];if(industry){sql.push('o.industry=?');args.push(industry);}if(employeeSize){sql.push("CASE WHEN o.employee_asof>=? THEN o.employee_range ELSE 'unknown' END=?");args.push(now()-365*86400000,employeeSize);}return {sql:sql.join(' AND '),args};}
 const entries=()=>database.query('SELECT data FROM organizations ORDER BY rowid').map(decode).map(view);
 return {
  database,
  importSeeds:inputs=>database.write(()=>{if(!Array.isArray(inputs)||inputs.length>500)throw Error('Import at most 500 reviewed companies.');const seeds=inputs.map(organizationSeed);for(const seed of seeds){const found=database.get('SELECT data FROM organizations WHERE domain=?',[seed.domain]);if(found){const old=decode(found);if(old.careers!==seed.careers)throw Error('Conflicting careers source requires explicit operator review.');old.industry=seed.industry;old.industryGroup=seed.industryGroup;if(seed.employees&&(!old.employees||seed.employees.asOf>=old.employees.asOf))old.employees=seed.employees;database.putOrganization(old);}else database.putOrganization({...seed,createdAt:now(),lastAttemptAt:null,checkedAt:null,observation:null});}return {count:database.get('SELECT count(*) AS count FROM organizations').count};}),
  list:(options={})=>{const filter=filters(options);return database.query('WITH page AS MATERIALIZED (SELECT o.id,o.sort_name FROM organizations o WHERE '+filter.sql+' ORDER BY o.sort_name,o.id LIMIT ? OFFSET ?) SELECT o.data FROM page p JOIN organizations o ON o.id=p.id ORDER BY p.sort_name,p.id',[...filter.args,pageSize(options.limit,30),pageOffset(options.offset)]).map(decode).map(view);},
  resolve:input=>{let domain;try{domain=organizationDomain(input.homepage);}catch{return null;}const found=database.get('SELECT data FROM organizations WHERE domain=?',[domain]);return found?view(decode(found)):null;},
  due:({limit=10,intervalMs=86400000}={})=>database.query('SELECT data FROM organizations WHERE last_attempt_at IS NULL OR last_attempt_at<=? ORDER BY last_attempt_at,id LIMIT ?',[now()-intervalMs,pageSize(limit,10)]).map(decode),
  refreshCandidates({vacancies,limit=10,intervalMs=86400000}={}){if(vacancies?.database?.file===database.file)return database.query('SELECT o.data FROM organizations o LEFT JOIN coverage c ON c.organization_id=o.id WHERE c.organization_id IS NULL OR c.next_refresh_at<=? ORDER BY coalesce(c.next_refresh_at,0),o.id LIMIT ?',[now(),Math.max(1,Math.min(200,limit))]).map(decode).map(view);return entries().filter(c=>vacancies.needsRefresh(c.id,intervalMs)).sort((a,b)=>vacancies.nextCheckAt(a.id)-vacancies.nextCheckAt(b.id)).slice(0,limit);},
  record:(id,outcome)=>database.write(()=>{const found=database.get('SELECT data FROM organizations WHERE id=?',[id]);if(!found)throw Error('Unknown catalog organization.');const row=decode(found);row.lastAttemptAt=now();if(outcome.error){row.lastError=text(outcome.error,120);}else{if(!['openings-observed','no-openings-observed','unknown'].includes(outcome.status)||!Array.isArray(outcome.sources)||outcome.sources.length>20||!Number.isInteger(outcome.openingCount)||outcome.openingCount<0||outcome.openingCount>100000)throw Error('Invalid catalog observation.');row.checkedAt=now();row.lastError=null;row.observation={status:outcome.status,openingCount:outcome.openingCount,sources:outcome.sources.map(x=>validatePublicUrl(x).href),ats:(outcome.ats??[]).slice(0,10).map(x=>validatePublicUrl(x).href)};}database.putOrganization(row);}),
  matchingCount:input=>{const filter=filters(typeof input==='string'?{query:input}:input);return database.get('SELECT count(*) AS count FROM organizations o WHERE '+filter.sql,filter.args).count;},
  facets:()=>{const industries=new Map(database.query('SELECT industry,count(*) AS count FROM organizations GROUP BY industry').map(row=>[row.industry,row.count])),sizes=new Map(database.query("SELECT CASE WHEN employee_asof>=? THEN employee_range ELSE 'unknown' END AS size,count(*) AS count FROM organizations GROUP BY size",[now()-365*86400000]).map(row=>[row.size,row.count]));return {industries:Object.entries(INDUSTRIES).map(([value,label])=>({value,label,count:industries.get(value)??0})),employeeSizes:[...EMPLOYEE_RANGES,'unknown'].map(value=>({value,label:value==='unknown'?'Size unknown':value+' employees',count:sizes.get(value)??0}))};},
  importVerified:input=>database.write(()=>{const seed=organizationSeed(input);if(input.provenance?.kind!=='public-website-linked-careers')throw Error('Independent public verification required.');if(database.get('SELECT id FROM organizations WHERE domain=?',[seed.domain]))return {added:false};database.putOrganization({...seed,industry:'',industryGroup:'unknown',employees:null,provenance:{kind:'public-website-linked-careers',url:seed.homepage,careersUrl:seed.careers},createdAt:now(),lastAttemptAt:null,checkedAt:null,observation:null});return {added:true};}),
  entries,
  count:()=>database.get('SELECT count(*) AS count FROM organizations').count,
  close:()=>owned?database.close():Promise.resolve()
 };
}
