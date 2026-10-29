import {countryKey,sourceLocations} from './vacancy-geography.mjs';
// Search labels are extracted evidence, never eligibility or an AI suitability score.
export const CLASSIFICATION_VERSION=2;
export const ROLE_RULES={
 'backend':/\b(back[ -]?end|server[ -]?side)\b/i,'frontend':/\b(front[ -]?end|web developer)\b/i,
 'full-stack':/\bfull[ -]?stack\b/i,'platform-sre':/\b(platform|site reliability|sre|devops|infrastructure)\b/i,
 'data':/\b(data (engineer|scientist|analyst)|analytics engineer|business intelligence)\b/i,
 'ai-ml':/\b(machine learning|artificial intelligence|ml engineer|ai engineer|research scientist)\b/i,
 'mobile':/\b(mobile|ios|android)\b/i,'security':/\b(security|appsec|infosec)\b/i,
 'qa':/\b(quality assurance|qa|test engineer|sdet)\b/i,'product':/\bproduct (manager|owner|lead)\b/i,
 'design':/\b(designer|ux|ui design)\b/i,'sales':/\b(sales|account executive|business development)\b/i,
 'marketing':/\b(marketing|growth manager)\b/i,'support':/\b(customer (support|success)|support engineer)\b/i,
 'engineering':/\b(engineer|developer)\b/i
};
const SKILLS={python:/\bpython\b/i,javascript:/\bjavascript\b/i,typescript:/\btypescript\b/i,java:/\bjava\b/i,golang:/\b(golang|go language)\b/i,rust:/\brust\b/i,ruby:/\bruby\b/i,php:/\bphp\b/i,'c++':/\bc\+\+/i,'c#':/\bc#/i,react:/\breact(?:\.js)?\b/i,vue:/\bvue(?:\.js)?\b/i,angular:/\bangular\b/i,nodejs:/\bnode(?:\.js|js)\b/i,sql:/\bsql\b/i,postgresql:/\bpostgres(?:ql)?\b/i,kubernetes:/\b(kubernetes|k8s)\b/i,docker:/\bdocker\b/i,terraform:/\bterraform\b/i,aws:/\b(aws|amazon web services)\b/i,azure:/\bazure\b/i,gcp:/\b(gcp|google cloud)\b/i,linux:/\blinux\b/i,pytorch:/\bpytorch\b/i,tensorflow:/\btensorflow\b/i,figma:/\bfigma\b/i};
const trim=(s,n=300)=>typeof s==='string'?s.trim().slice(0,n):'';
export function classifyVacancy(row){
 const title=trim(row.title,200),text=trim(row.text,10000),facts=row.facts??{},location=trim(row.location),all=title+'\n'+text;
 const roles=Object.entries(ROLE_RULES).filter(([,rule])=>rule.test(title)).map(([key])=>key);
 const levels=[['intern',/\b(intern|internship|apprentice)\b/i],['junior',/\b(junior|jr\.?|entry[ -]level)\b/i],['senior',/\b(senior|sr\.?)\b/i],['staff',/\bstaff\b/i],['principal',/\bprincipal\b/i],['lead',/\b(lead|head of)\b/i],['manager',/\b(manager|director|vp|vice president)\b/i]].filter(([,rule])=>rule.test(title)).map(([key])=>key);
 const workplace=trim(facts.workplaceType).toLowerCase(),workModes=['remote','hybrid','onsite'].filter(mode=>workplace.replace(/[ -]/g,'')===mode||new RegExp('\\b'+(mode==='onsite'?'on[ -]?site':mode)+'\\b','i').test(title+' '+location));
 const employments=[facts.employmentType,...(Array.isArray(facts.employmentTypes)?facts.employmentTypes:[])].map(x=>trim(x).toLowerCase().replace(/[ _-]/g,''));
 const employmentTypes=Object.entries({'full-time':'fulltime','part-time':'parttime','contract':'contract','internship':'intern','temporary':'temporary'}).filter(([key,value])=>employments.some(employment=>employment===value||employment===key.replace('-','')||value==='contract'&&employment==='contractor')||new RegExp('\\b'+key.replace('-','[ -]')+'\\b','i').test(title)).map(([key])=>key);
 return {version:CLASSIFICATION_VERSION,roles:roles.length?roles:['unknown'],levels:levels.length?levels:['unknown'],workModes:workModes.length?workModes:['unknown'],employmentTypes:employmentTypes.length?employmentTypes:['unknown'],skills:Object.entries(SKILLS).filter(([,rule])=>rule.test(all)).map(([key])=>key),department:trim(facts.department),team:trim(facts.team),country:trim(facts.country,100),countries:[...new Set([facts.country,...(Array.isArray(facts.countries)?facts.countries:[])].map(x=>trim(x,100)).filter(Boolean))].slice(0,20),locations:sourceLocations(row),basis:'Title, location and source metadata; skills are text mentions, not confirmed requirements. Remote does not establish country eligibility.'};
}
export function salaryComponents(value){return (Array.isArray(value)?value:[]).slice(0,20).filter(x=>x?.compensationType==='Salary'&&/^[A-Z]{3}$/.test(x.currencyCode)&&['1 YEAR','1 MONTH','1 HOUR'].includes(x.interval)&&typeof x.minValue==='number'&&Number.isFinite(x.minValue)&&x.minValue>=0&&typeof x.maxValue==='number'&&Number.isFinite(x.maxValue)&&x.maxValue>=x.minValue).map(x=>({currency:x.currencyCode,interval:x.interval,min:x.minValue,max:x.maxValue}));}
export function normalizeVacancyFacts(facts={}){return {...Object.fromEntries(['department','team','country','employmentType','workplaceType'].map(key=>[key,trim(facts?.[key])])),salary:salaryComponents(facts?.salary),...Object.fromEntries(['locations','countries','employmentTypes','applicantLocations'].map(key=>[key,[...new Set((Array.isArray(facts?.[key])?facts[key]:[]).slice(0,20).map(x=>trim(x,300)).filter(Boolean))]]))};}
const tokens=value=>Array.isArray(value)?value.slice(0,30).map(x=>trim(x,100).toLowerCase()).filter(Boolean):String(value??'').slice(0,1000).split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).slice(0,30);
export function matchesVacancyLabels(row,filters={}){
 const labels=row.classification??classifyVacancy(row);
 for(const [filter,key]of [['role','roles'],['level','levels'],['workMode','workModes'],['employmentType','employmentTypes']]){const wanted=tokens(filters[filter]);if(wanted.length&&!wanted.some(v=>labels[key].includes(v)))return false;}
 const skills=tokens(filters.skills);if(skills.length&&!(filters.skillMatch==='any'?skills.some(v=>labels.skills.includes(v)):skills.every(v=>labels.skills.includes(v))))return false;
 const searchable=(row.title+' '+row.companyName+' '+row.location+' '+row.text).toLowerCase();
 if(tokens(filters.exclude).some(v=>(searchable+' '+sourceLocations(row).join(' ').toLowerCase()).includes(v)))return false;
 if(filters.location&&!sourceLocations(row).some(location=>location.toLowerCase().includes(trim(filters.location,200).toLowerCase())))return false;
 if(filters.country&&!(labels.countries??[labels.country]).some(country=>countryKey(country)===countryKey(filters.country)))return false;
 if(filters.industry&&(row.industryGroup??'unknown')!==filters.industry)return false;
 const salaries=row.facts?.salary??[];if(filters.salaryDisclosed==='yes'&&!salaries.length)return false;
 if(filters.salaryMin){const minimum=Number(filters.salaryMin);if(!Number.isFinite(minimum)||minimum<0||!filters.currency||!filters.salaryInterval||!salaries.some(s=>s.currency===filters.currency&&s.interval===filters.salaryInterval&&s.max>=minimum))return false;}
 return true;
}
export function vacancyFacets(rows){const dimensions={role:'roles',level:'levels',workMode:'workModes',employmentType:'employmentTypes',skills:'skills'};return Object.fromEntries(Object.entries(dimensions).map(([filter,key])=>{const counts=new Map();for(const row of rows)for(const value of(row.classification??classifyVacancy(row))[key])counts.set(value,(counts.get(value)??0)+1);return[filter,[...counts].sort(([a],[b])=>a.localeCompare(b)).map(([value,count])=>({value,count}))];}));}
