// Shared server/browser ordering. Coverage is evidence bookkeeping, never hiring probability.
export function evidenceSummary(job,assessment=job.assessment){
 const core=(job.requirements??[]).filter(r=>r.core);
 const rows=core.map(r=>assessment?.rows?.find(a=>a.requirementId===r.id));
 const count=status=>rows.filter(r=>r?.status===status).length;
 const full=count('supported'),partial=count('partial'),gaps=count('gap');
 return {full,partial,gaps,unknown:core.length-full-partial-gaps,total:core.length,level:!assessment?'Unavailable':assessment.direction==='different'?'Different function':core.length&&full===core.length?'Full evidence':full||partial?'Partial evidence':'Unconfirmed'};
}
const categories={'Worth reviewing':0,Conditional:1,'Low priority':2};
const directions={aligned:0,uncertain:1,different:2};
const preferences={'Higher preference':0,Neutral:1,'Lower preference':2};
function fractionCompare(aCount,aTotal,bCount,bTotal){return aCount*(bTotal||1)-bCount*(aTotal||1);}
export function compareResults(a,b){
 const aFit=evidenceSummary(a),bFit=evidenceSummary(b);
 return (a.assessment?(categories[a.category]??3):3)-(b.assessment?(categories[b.category]??3):3)
  ||(directions[a.assessment?.direction]??3)-(directions[b.assessment?.direction]??3)
  ||-fractionCompare(aFit.full,aFit.total,bFit.full,bFit.total)
  ||-fractionCompare(aFit.partial,aFit.total,bFit.partial,bFit.total)
  ||fractionCompare(aFit.gaps,aFit.total,bFit.gaps,bFit.total)
  ||({clear:0,unconfirmed:1,conflict:2}[a.conditionState]??1)-({clear:0,unconfirmed:1,conflict:2}[b.conditionState]??1)
  ||(preferences[a.preferenceBand]??1)-(preferences[b.preferenceBand]??1)
  ||String(a.url??a.key??a.id??'').localeCompare(String(b.url??b.key??b.id??''));
}
export const rankResults=rows=>[...rows].sort(compareResults);
