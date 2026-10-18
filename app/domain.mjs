import {createHash,randomUUID} from 'node:crypto';
// Full country/territory names recognized by the local ICU database. Region groups
// deliberately remain unknown: a regional remote policy does not prove payroll eligibility.
const regionNames=new Intl.DisplayNames(['en'],{type:'region'});
const countryNames=new Map();
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
 const code=String.fromCharCode(a,b);if(['EU','UN','EZ','QO','XA','XB','ZZ'].includes(code))continue;
 const name=regionNames.of(code);if(name&&name!==code)countryNames.set(name.toLowerCase(),name);
}
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const id=()=>randomUUID();
export function cleanText(value,max=2000){if(typeof value!=='string'||value.trim().length>max)throw Error('Invalid text input.');return value.trim();}
export function validateProfile(input){
 if(!input||!Array.isArray(input.facts)||input.facts.length<1||input.facts.length>30)throw Error('Add at least one experience fact (maximum 30).');
 const facts=input.facts.map((f,i)=>({id:cleanText(f.id??`f${i+1}`,50),text:cleanText(f.text,1500)}));
 if(facts.some(f=>!f.id||!f.text)||new Set(facts.map(f=>f.id)).size!==facts.length)throw Error('Each experience fact needs unique identification and text.');
 const g=input.goal??{};const goal={roles:cleanText(g.roles??'',200),industries:cleanText(g.industries??'',200),country:cleanText(g.country??'',100),workMode:cleanText(g.workMode??'remote',20)};
 if(!goal.roles||!goal.country)throw Error('Add target roles and a permitted work country.');
 if(!countryNames.has(goal.country.toLowerCase()))throw Error('Use a full work-country name, such as Portugal or United States.');
 goal.country=countryNames.get(goal.country.toLowerCase());
 if(!['remote','hybrid','onsite','any'].includes(goal.workMode))throw Error('Choose a valid work mode.');
 return {facts,goal,...(input.preferences===undefined?{}:{preferences:validatePreferences(input.preferences)})};
}

function country(value){const name=cleanText(value,100);const full=countryNames.get(name.toLowerCase());if(!full)throw Error('Use a recognized full country name.');return full;}
function choice(value,allowed,fallback){const v=value??fallback;if(!allowed.includes(v))throw Error('Invalid preference choice.');return v;}
function list(value){if(value===undefined)return [];if(!Array.isArray(value)||value.length>20)throw Error('Use at most 20 preference terms.');return [...new Set(value.map(v=>cleanText(v,120)).filter(Boolean))];}
export function validatePreferences(p){
 if(!p||typeof p!=='object'||Array.isArray(p))throw Error('Invalid preferences.');
 const relocations=p.relocations??[];if(!Array.isArray(relocations)||relocations.length>5)throw Error('Use at most five relocation destinations.');
 const normalized={careerPriority:choice(p.careerPriority,['content','relocation','balanced'],'content'),leadershipRequired:p.leadershipRequired===true,officePolicy:choice(p.officePolicy,['deprioritize','neutral'],'neutral'),relocations:relocations.map(r=>({country:country(r.country),tentative:r.tentative===true})),preferredThemes:list(p.preferredThemes),preferredIndustries:list(p.preferredIndustries),disfavoredIndustries:list(p.disfavoredIndustries),themesConfirmed:p.themesConfirmed===true,industriesConfirmed:p.industriesConfirmed===true};
 if(new Set(normalized.relocations.map(r=>r.country)).size!==normalized.relocations.length)throw Error('Remove duplicate relocation destinations.');
 if(p.salary!=null){const v=p.salary;const lo=Number(v.targetMin),hi=Number(v.targetMax);if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo<0||hi<lo||hi>10000000)throw Error('Salary range must be ordered, non-negative annual amounts.');normalized.salary={country:country(v.country),currency:choice(v.currency,['EUR','USD','GBP','NOK','NZD'],'EUR'),targetMin:lo,targetMax:hi,period:choice(v.period,['year'],'year'),basis:choice(v.basis,['pending','base','total'],'pending'),policy:choice(v.policy,['pending','soft','hard'],'pending'),unknownPolicy:choice(v.unknownPolicy,['pending','keep','exclude'],'pending')};}
 const rights=p.workAuthorizations??[];if(!Array.isArray(rights)||rights.length>10)throw Error('Invalid work authorization records.');normalized.workAuthorizations=rights.map(r=>({country:country(r.country),status:choice(r.status,['yes','no','unknown'],'unknown')}));
 return normalized;
}
export function intakeQuestions(profile){
 if(!profile)return [];
 const p=profile.preferences;if(!p)return ['Add your career priorities, relocation options and salary preferences when ready.'];
 const questions=[];if(!p.salary)questions.push('What annual salary range should apply, and in which country/currency?');else{if(!p.salary.basis||p.salary.basis==='pending')questions.push('Does your salary target mean fixed base salary or total cash including bonus?');if(p.salary.policy==='pending')questions.push('Should salary below your target lower priority or exclude a role?');if(p.salary.unknownPolicy==='pending')questions.push('Should vacancies with unknown salary stay in the shortlist?');}
 if(!p.themesConfirmed)questions.push('Which work themes should increase priority? Confirm your preferred themes.');if(!p.industriesConfirmed)questions.push('Which industries should lower priority? Confirm a list or explicitly leave it empty.');return questions;
}

export function canonicalUrl(value){const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(k.startsWith('utm_')||['ref','source','gh_src'].includes(k))u.searchParams.delete(k);return u.href.replace(/\/$/,'');}
export function officialJob(company,job,atsLinks=[]){
 const u=new URL(job.url),c=new URL(company.homepage);if(u.protocol!=='https:'||u.username||u.password)return false;
 if(u.hostname===c.hostname||u.hostname.endsWith('.'+c.hostname))return true;
 return atsLinks.some(a=>{try{const link=new URL(a.url);return a.linkedFrom===company.careers&&u.origin===link.origin&&(u.pathname===link.pathname||u.pathname.startsWith(link.pathname.replace(/\/$/,'')+'/'));}catch{return false;}});
}
export function validateJob(j){
 if(!j||typeof j!=='object')throw Error('Unusable listing.');
 const title=cleanText(j.title,250),text=cleanText(j.text,40000),url=canonicalUrl(j.url);
 if(!title||!text||!Array.isArray(j.requirements)||!j.requirements.length||j.requirements.length>20)throw Error('Listing has no verifiable requirements.');
 const requirements=j.requirements.map(r=>({id:cleanText(r.id,100),text:cleanText(r.text,2000),core:r.core!==false}));
 if(requirements.some(r=>!r.id||!r.text||!text.includes(r.text))||new Set(requirements.map(r=>r.id)).size!==requirements.length)throw Error('Requirements must quote the listing exactly.');
 const countries=Array.isArray(j.countries)?j.countries.slice(0,30).filter(x=>typeof x==='string'&&x.length<100&&countryNames.has(x.toLowerCase())&&text.toLowerCase().includes(x.toLowerCase())):[];
 const workMode=['remote','hybrid','onsite'].includes(j.workMode)&&text.toLowerCase().includes(j.workMode)?j.workMode:'unknown';
 let authorizationRequirement=null;
 if(j.authorizationRequirement!=null){const a=j.authorizationRequirement;const c=country(a.country);const q=cleanText(a.quote,1200);if(a.requiresExisting!==true||!text.includes(q)||!q.toLowerCase().includes(c.toLowerCase())||!/(must|required|require|mandatory|without sponsorship)/i.test(q))throw Error('Authorization restriction needs an exact explicit source quote.');authorizationRequirement={country:c,requiresExisting:true,quote:q};}
 const salary=typeof j.salary==='string'&&text.includes(j.salary)?j.salary:null;
 return {id:typeof j.id==='string'?j.id.slice(0,150):null,title,text,url,countries,workMode,salary,requirements,authorizationRequirement};
}
export function validateAssessment(a,job,profile){
 const fail=()=>{throw Error('Invalid assessment: evidence did not pass validation.');};
 if(!a||!['aligned','uncertain','different'].includes(a.direction)||typeof a.directionReason!=='string'||a.directionReason.length>1200||!Array.isArray(a.rows)||a.rows.length!==job.requirements.length)fail();
 const seen=new Set();const rows=a.rows.map(row=>{
  const req=job.requirements.find(r=>r.id===row.requirementId);
  if(!req||seen.has(req.id)||!['supported','gap','unknown'].includes(row.status)||typeof row.jobQuote!=='string'||!row.jobQuote.trim()||!req.text.includes(row.jobQuote))fail();seen.add(req.id);
  if(row.status==='supported'){
   const fact=profile.facts.find(f=>f.id===row.factId);
   if(!fact||typeof row.profileQuote!=='string'||!row.profileQuote.trim()||!fact.text.includes(row.profileQuote))fail();
  }else if(row.factId!=null||row.profileQuote!=null)fail();
  return {requirementId:req.id,status:row.status,factId:row.factId??null,profileQuote:row.profileQuote??null,jobQuote:row.jobQuote};
 });return {direction:a.direction,directionReason:a.directionReason,rows};
}
export function classify(job,assessment,profile,context={}){
 const g=profile.goal;const prefs=profile.preferences;const preferenceNotes=[];const countries=job.countries.map(s=>s.toLowerCase());let mismatch=false,unknown=false;const notes=[];
 if(!countries.length){unknown=true;notes.push('Work-country eligibility is unknown.');}
 else if(!countries.includes(g.country.toLowerCase())){
  const relocation=prefs?.relocations?.find(r=>countries.includes(r.country.toLowerCase()));
  if(relocation){unknown=true;notes.push(`Relocation to ${relocation.country}${relocation.tentative?' is tentative':' is an option'}. Work authorization and employer support need confirmation.`);}
  else if(prefs){unknown=true;notes.push(`Published countries: ${job.countries.join(', ')}. This is outside your preferred relocation routes; willingness to move and work authorization need confirmation.`);}
  else{mismatch=true;notes.push(`Published countries: ${job.countries.join(', ')}. Your required country: ${g.country}.`);}
 }
 else notes.push(`Country stated: ${g.country}. Employment/payroll setup still needs employer confirmation.`);
 if(g.workMode!=='any'){
  if(job.workMode==='unknown'){unknown=true;notes.push('Work mode is unknown.');}
  else if(job.workMode!==g.workMode){mismatch=true;notes.push(`Published work mode: ${job.workMode}; required: ${g.workMode}.`);}
 }
 if(job.authorizationRequirement){const restriction=job.authorizationRequirement;const right=prefs?.workAuthorizations?.find(r=>r.country===restriction.country);if(right?.status==='no'){mismatch=true;notes.push(`The listing requires existing work authorization in ${restriction.country}; your confirmed record is no. Relocation interest does not remove this restriction.`);}else if(right?.status!=='yes'){unknown=true;notes.push(`Existing work authorization in ${restriction.country} must be verified.`);}}
 const core=job.requirements.filter(r=>r.core);const coreRows=assessment.rows.filter(r=>core.some(c=>c.id===r.requirementId));
 const supported=coreRows.filter(r=>r.status==='supported').length;
 let category='Worth reviewing';
 if(mismatch||(coreRows.length>0&&coreRows.every(r=>r.status==='gap'))||assessment.direction==='different')category='Low priority';
 else if(unknown||supported===0||coreRows.some(r=>r.status!=='supported')||assessment.direction==='uncertain')category='Conditional';
 let preferenceBand='Neutral';
 if(prefs?.officePolicy==='deprioritize'&&job.workMode==='onsite'){preferenceNotes.push('Mandatory office work lowers your preference; it is not an automatic exclusion.');preferenceBand='Lower preference';}
 const tags=typeof context.industry==='string'?context.industry.split(/[,/;]+/).map(s=>s.trim().toLowerCase()):[];
 if(prefs?.industriesConfirmed&&prefs.disfavoredIndustries.some(s=>tags.includes(s.toLowerCase()))){preferenceNotes.push('Employer industry matches your lower-preference list (user-provided industry tag).');preferenceBand='Lower preference';}
 if(prefs?.industriesConfirmed&&prefs.preferredIndustries?.some(s=>tags.includes(s.toLowerCase()))){preferenceNotes.push('Employer industry matches your preferred domains (user-provided industry tag).');if(preferenceBand==='Neutral')preferenceBand='Higher preference';}
 if(prefs?.themesConfirmed&&prefs.preferredThemes.some(s=>tags.includes(s.toLowerCase()))){preferenceNotes.push('Employer tag matches a confirmed preferred theme.');if(preferenceBand==='Neutral')preferenceBand='Higher preference';}
 if(prefs?.salary){const target=prefs.salary;const published=comparableSalary(job.salary);
  if(!job.salary){preferenceNotes.push('Salary not published; retain and clarify.');if(target.unknownPolicy==='exclude')category='Low priority';}
  else if(target.basis==='base'&&published&&published.currency===target.currency&&countries.includes(target.country.toLowerCase())&&published.max<target.targetMin){preferenceNotes.push('Published comparable annual base salary is below your country-specific target.');if(target.policy==='soft')preferenceBand='Lower preference';if(target.policy==='hard')category='Low priority';}
  else if(target.basis!=='base'||!published||published.currency!==target.currency)preferenceNotes.push('Salary currency, annual period or base-pay basis is not comparable; no automatic penalty.');
  preferenceNotes.push(`Salary target: ${prefs.salary.currency} ${prefs.salary.targetMin.toLocaleString('en')}–${prefs.salary.targetMax.toLocaleString('en')} gross/year for ${prefs.salary.country} (${prefs.salary.basis==='base'?'fixed base':prefs.salary.basis==='total'?'total cash':'pay basis to clarify'}). ${prefs.salary.policy==='pending'?'Below-target policy is not confirmed.':prefs.salary.policy==='soft'?'Below-target pay lowers preference, not eligibility.':'Only verified comparable annual base ranges can enforce this policy.'}`);}
 return {category,preferenceBand,preferenceNotes,intakeQuestions:intakeQuestions(profile),constraints:notes.join(' '),experience:`${supported} of ${coreRows.length} core requirements supported by profile evidence.`,direction:assessment.directionReason};
}

function comparableSalary(raw){
 if(typeof raw!=='string'||!/(annual|yearly|per year|per annum|\/year)/i.test(raw)||!/(base|gross)/i.test(raw))return null;
 const currency=/EUR|€/.test(raw)?'EUR':/USD|\$/.test(raw)?'USD':/GBP|£/.test(raw)?'GBP':null;if(!currency)return null;
 const found=raw.match(/\d+(?:,\d{3})*(?:\.\d+)?\s*[kK]?/g)??[];if(found.length<1||found.length>2)return null;
 const values=found.map(v=>Number(v.replaceAll(',','').replace(/[kK]\s*$/,''))* (/[kK]\s*$/.test(v)?1000:1));if(values.some(v=>!Number.isFinite(v)||v<1000)||values.some((v,i)=>i&&v<values[i-1]))return null;
 return {currency,min:values[0],max:values.at(-1)};
}
