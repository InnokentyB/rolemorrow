import {hash,id} from './domain.mjs';
export const stages=['saved','applied','interview','offer','rejected','withdrawn','archived'];
export function opportunityKey(result,mode){
 const url=new URL(result.url);url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||['ref','referrer','source','gh_src'].includes(key.toLowerCase()))url.searchParams.delete(key);url.searchParams.sort();url.pathname=url.pathname.replace(/\/$/,'')||'/';
 const employer=new URL(result.source.linkedFrom||result.url).hostname.toLowerCase().replace(/^www\./,'');
 return hash({namespace:mode==='fixture'?'fixture':'real',employer,url:url.href});
}
export function observe(opportunity,result,run){
 if(result.source.authority==='user-supplied unverified'&&opportunity.snapshot.source.authority!=='user-supplied unverified')return;
 opportunity.snapshot=structuredClone(result);opportunity.runMode=run.mode;opportunity.latestObservedAt=result.source.checkedAt;
}
export function saveOpportunity(state,result){
 const key=opportunityKey(result,state.run.mode);const found=state.opportunities.find(o=>o.identity===key);if(found)return found;
 const now=new Date().toISOString();const opportunity={id:id(),identity:key,firstSavedAt:now,latestObservedAt:result.source.checkedAt,runMode:state.run.mode,snapshot:structuredClone(result),stage:'saved',note:'',nextAction:'',dueDate:'',decisionRevision:0,updatedAt:now,events:[{at:now,stage:'saved',origin:'candidate'}]};state.opportunities.push(opportunity);return opportunity;
}
export function validateDecision(body){
 if(!Number.isInteger(body.decisionRevision)||body.decisionRevision<0)throw Error('Decision revision required. Reload saved jobs.');
 if(!stages.includes(body.stage))throw Error('Choose a supported application stage.');
 for(const [key,max] of [['note',4000],['nextAction',500]])if(typeof body[key]!=='string'||body[key].length>max)throw Error(`Check ${key} length.`);
 if(typeof body.dueDate!=='string'||body.dueDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)||!Number.isFinite(Date.parse(body.dueDate))||new Date(body.dueDate).toISOString().slice(0,10)!==body.dueDate))throw Error('Enter a valid calendar date.');
 return {stage:body.stage,note:body.note.trim(),nextAction:body.nextAction.trim(),dueDate:body.dueDate};
}
