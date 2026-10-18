// Bounded English profession recognition. Unknown/hybrid titles keep model judgment.
const families={product:/\bproduct manager\b|\blead pm\b|\b(?:head|director) of product\b(?!\s+(?:marketing|design|engineering))/i,engineering:/\b(?:machine learning|ml|software|frontend|front.end|backend|back.end|platform|data|product) engineer\b/i,design:/\b(?:product|ux|ui|user experience) designer\b/i,marketing:/\bproduct marketing\b/i};
const recognize=text=>Object.entries(families).filter(([,pattern])=>pattern.test(text??'')).map(([family])=>family);
export function normalizeRoleDirection(title,goals,assessment){
 const role=recognize(title),targets=recognize(goals);
 if(role.length===1&&targets.length&&!targets.includes(role[0]))return {...assessment,direction:'different',directionReason:`The ${role[0]} role is a different profession from the explicitly stated ${targets.join(' / ')} career direction. Shared skills do not establish the same function.`};
 return assessment;
}
export function levelReview(job,assessment){
 const label=job.title?.match(/\b(?:junior|senior|lead|staff|principal|head|director|vp|chief)\b/i)?.[0]??null;
 const scope=(job.requirements??[]).filter(r=>r.core&&(/\b\d+\s*\+?\s*(?:years?|yrs?)\b/i.test(r.text)||/\b(?:manage|lead|direct|supervise)\b[^.!?]{0,60}\b(?:teams?|people|managers?|reports)\b|\bdirect reports\b/i.test(r.text)));
 if(!label&&!scope.length)return {status:'not-specified',label:null,text:'The listing does not establish a level requirement. Confirm scope with the employer.',requirementIds:[]};
 const evidenced=scope.length>0&&scope.every(r=>assessment.rows.some(row=>row.requirementId===r.id&&row.status==='supported'));
 return {status:evidenced?'stated-scope-evidenced':'unconfirmed',label,text:evidenced?'Evidence supports the stated experience or management requirements. Overall level and decision authority still need employer review.':`${label?label+' title. ':''}Role level is unconfirmed. Review required tenure, scope and decision authority; a supported skill alone does not establish seniority.`,requirementIds:scope.map(r=>r.id)};
}
