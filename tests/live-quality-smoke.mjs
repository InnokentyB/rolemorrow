// Explicit opt-in manual check. Never part of npm test or CI. Synthetic applicant only.
import {getProviders} from '../app/providers.mjs';
import {validateProfile,validateJob,validateAssessment,classify,officialJob} from '../app/domain.mjs';
if(process.env.CONFIRM_LIVE_QUALITY!=='1')throw Error('Set CONFIRM_LIVE_QUALITY=1 to authorize a bounded real-provider check.');
const profile=validateProfile({facts:[{id:'demo-api',text:'Led enterprise API integration onboarding for a B2B platform.'},{id:'demo-sql',text:'Personally wrote SQL queries with window functions for customer analytics.'}],goal:{roles:'Product Manager',industries:'Software',country:'Portugal',workMode:'any'}});
const company={name:'Constructor',homepage:'https://constructor.com',careers:'https://constructor.com/about/careers'};
const env={...process.env,ALLOW_LIVE:'1',LIVE_MAX_JOBS_PER_COMPANY:'1'};
const providers=getProviders({env});const signal=AbortSignal.timeout(150000);
try{
 const discovered=await providers.discover(company,{profile,signal});
 if(discovered.jobs.length!==1)throw Error('No individual posting available for the bounded check.');
 const raw=discovered.jobs[0];if(!officialJob(company,raw,discovered.atsLinks))throw Error('Source authority failed.');
 const job=validateJob(raw);const assessment=validateAssessment(await providers.assess(job,profile,{signal}),job,profile);
 const classification=classify(job,assessment,profile);
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),applicant:'fictional two-fact applicant',mode:'actual provider calls',extractionModel:env.NEBIUS_MODEL,assessmentModel:env.NEBIUS_ASSESSMENT_MODEL||env.NEBIUS_MODEL,company:company.name,url:job.url,title:job.title,requirements:job.requirements,assessment,classification,coverage:discovered.coverage,semanticAcceptance:'Pending manual source/entailment review; successful structured inference is not a quality verdict.'},null,2));
}catch(error){console.error(JSON.stringify({status:'failed',failureType:error.name,networkCode:error.cause?.code??null,diagnostic: /^(Provider returned malformed JSON|Model returned invalid structured evidence|Live provider configuration is incomplete\.|Source request failed \(\d+\)\.|Unsafe|Blocked|Invalid|Public|URL|Address)/.test(error.message)?error.message.slice(0,140):'Details withheld',stage: error.message==='No individual posting available for the bounded check.'?'discovery returned no posting':error.message.startsWith('Invalid assessment')?'assessment validation':'provider or source unavailable',checkedAt:new Date().toISOString()}));process.exitCode=1;}
