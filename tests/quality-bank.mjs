// Frozen original fictional texts, no private applicant information or changing vacancies.
export const benchmarkVersion='platform-bank-2026-10-18-v1';
export const compound='Own API integrations and build product health dashboards.';
export const profiles={
 api:{facts:[{id:'api',text:'I own API integrations.'}],goal:{roles:'Product Manager',industries:'software',country:'Portugal',workMode:'any'}},
 platform:{facts:[{id:'platform',text:'I own API integrations and build product health dashboards.'}],goal:{roles:'Product Manager',industries:'software',country:'Portugal',workMode:'any'}},
 finance:{facts:[{id:'finance',text:'I work with Finance and Risk on settlement.'}],goal:{roles:'Product Manager',industries:'fintech',country:'Portugal',workMode:'any'}}
};
const make=(id,title,requirement,country='Portugal',extra=[])=>({id,title,url:`https://northstar.example/careers/${id}`,text:`${requirement} ${extra.map(r=>r.text).join(' ')} Remote in ${country}.`,countries:[country],workMode:'remote',salary:null,requirements:[{id:'r1',text:requirement,core:true},...extra]});
export const jobs=[make('e','API Product Manager','Own API integrations.','Portugal',[{id:'r2',text:'Rust is a plus.',core:false}]),make('c','Frontend Engineer','Own API integrations.'),make('b','Payments Product Manager','Work with Finance and Risk on settlement.'),make('a','Platform Product Manager',compound),make('d','US Platform Product Manager',compound,'United States')];
export const expected={
 api:{statuses:{a:'partial',b:'unknown',c:'supported',d:'partial',e:'supported'},order:['e','a','b','d','c']},
 platform:{statuses:{a:'supported',b:'unknown',c:'supported',d:'supported',e:'supported'},order:['a','e','b','d','c']},
 finance:{statuses:{a:'unknown',b:'supported',c:'unknown',d:'unknown',e:'unknown'},order:['b','a','e','d','c']}
};
// Named deterministic adapter proves contract/lifecycle only. It is NOT model evaluation.
export const benchmarkProviders={
 async discover(c){return {jobs:c.name==='Northstar'?structuredClone(jobs):[],coverage:'checked'};},
 async assess(job,profile){const rows=job.requirements.map(r=>{
  const api=profile.facts.find(f=>f.text.includes('own API integrations'));
  const full=profile.facts.find(f=>f.text.includes('own API integrations and build product health dashboards'));
  const finance=profile.facts.find(f=>f.text.includes('work with Finance and Risk on settlement'));
  if(r.text===compound&&api&&!full)return {requirementId:r.id,status:'partial',factId:api.id,profileQuote:api.text,jobQuote:'Own API integrations',unconfirmedQuote:'build product health dashboards'};
  const fact=r.text===compound?full:r.text==='Own API integrations.'?api:r.text==='Work with Finance and Risk on settlement.'?finance:null;
  return {requirementId:r.id,status:fact?'supported':'unknown',factId:fact?.id??null,profileQuote:fact?.text??null,jobQuote:r.text};
 });return {direction:job.title==='Frontend Engineer'?'different':'aligned',directionReason:job.title==='Frontend Engineer'?'Engineering differs from the Product Manager goal.':'Product Manager role matches the stated goal.',rows};}
};
