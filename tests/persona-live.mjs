// Opt-in, at most 24 actual inference calls; synthetic data only, no job discovery.
import{getProviders}from'../app/providers.mjs';import{validateAssessment,classify,validateProfile,validateJob}from'../app/domain.mjs';import{people,jobs,cases,version}from'./persona-bank.mjs';import{EVIDENCE_POLICY}from'../app/server.mjs';
if(process.env.CONFIRM_PERSONA_QUALITY!=='1')throw Error('Set CONFIRM_PERSONA_QUALITY=1 to run twelve synthetic cases (up to 24 inference calls).');
const provider=getProviders(),results=[];
for(const c of cases){const profile=validateProfile(people[c.personId].profile),job=validateJob(jobs[c.jobId]);try{
 const assessment=validateAssessment(await provider.assess(job,profile,{signal:AbortSignal.timeout(90000)}),job,profile);const actual=assessment.rows[0].status;
 results.push({...c,name:people[c.personId].name,title:job.title,actual,actualDirection:assessment.direction,pass:actual===c.status&&assessment.direction===c.direction,falseSupported:actual==='supported'&&c.status!=='supported',falseNegative:c.status==='supported'&&actual!=='supported',assessment,classification:classify(job,assessment,profile)});
 }catch{results.push({...c,name:people[c.personId].name,title:job.title,pass:false,error:'Provider or evidence validation unavailable.'});}
}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),benchmarkVersion:version,evidencePolicy:EVIDENCE_POLICY,syntheticOnly:true,mode:'actual Nebius inference',model:process.env.NEBIUS_ASSESSMENT_MODEL||process.env.NEBIUS_MODEL,profiles:6,cases:results.length,passed:results.filter(r=>r.pass).length,falseSupported:results.filter(r=>r.falseSupported).length,falseNegative:results.filter(r=>r.falseNegative).length,people,results,limit:'Small authored synthetic set; not market accuracy or human acceptance.'},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
