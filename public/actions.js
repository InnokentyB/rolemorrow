// Read-only projection of canonical decisions, packets, source observations and mail tasks.
export function nextActions(state,today=new Date().toISOString().slice(0,10)){
 const items=[];const add=(o,kind,title,target,priority)=>items.push({opportunityId:o.id,kind,title,target,priority,company:o.snapshot.company,role:o.snapshot.title});
 for(const o of state.opportunities??[]){if(['archived','rejected','withdrawn'].includes(o.stage))continue;
 if(o.nextAction||o.dueDate)add(o,o.dueDate&&o.dueDate<today?'overdue':'planned',`${o.dueDate&&o.dueDate<today?'Overdue · ':''}${o.nextAction||'Review saved role'}${o.dueDate?' · '+o.dueDate:''}`,'saved',o.dueDate&&o.dueDate<today?0:6);
 if(o.sourceReviewRequired??['changed','possibly-closed','not-found'].includes(o.sourceCheck?.status))add(o,'source','Review vacancy source changes or availability','saved',2);
 if(o.assessmentStale)add(o,'assessment-review','Review an earlier fit assessment','saved',3);
 if(o.stage==='saved'){
 if(o.snapshot.clarifications?.length)add(o,'clarify',`Review ${o.snapshot.clarifications.length} unconfirmed requirement(s)`,'saved',3);
 const packet=state.applications?.find(a=>a.opportunityId===o.id);const stale=packet&&state.profile&&packet.profileVersion!==state.profile.version;add(o,stale?'packet-stale':packet?'packet-ready':'packet-missing',stale?'Review packet prepared with an earlier profile':packet?'Application packet saved — review before applying':'Prepare an application packet','applications',stale?3:packet?4:5);
 }
 for(const m of state.messages??[])if(m.opportunityId===o.id&&m.analysis?.action&&!m.task?.done)add(o,'message',m.analysis.action,'applications',1);
 }
 return items.sort((a,b)=>a.priority-b.priority||String(a.company??'').localeCompare(String(b.company??''))||a.opportunityId.localeCompare(b.opportunityId));
}
