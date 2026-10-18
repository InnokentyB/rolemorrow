// Operator-invoked acceptance against a NEW fictional demo workspace only.
import assert from 'node:assert/strict';
const base=process.env.DEMO_ORIGIN??'http://127.0.0.1:3028';
if(process.env.CONFIRM_FRESH_DEMO!=='1'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Confirm a fresh loopback-only demo workspace.');
const call=async(path,body,method='POST')=>{const r=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
const state=()=>call('/api/state',undefined,'GET');let s=await state();
assert.equal(s.config.liveReady,false);assert.equal(s.profile,null,'Refuse to overwrite an existing workspace.');
await call('/api/profile',{facts:[{id:'f1',text:'Led AI product evaluation and API platform launches.'}],goal:{roles:'Product Manager',industries:'AI',country:'Portugal',workMode:'remote'}});
await call('/api/companies',{companies:['Northstar','Fieldwork','Meridian'].map(name=>({name,homepage:`https://${name.toLowerCase()}.example`,careers:`https://${name.toLowerCase()}.example/careers`,industry:'AI'}))});
await call('/api/scans',{mode:'fixture'});
for(let i=0;i<100;i++){s=await state();if(s.run.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
assert.equal(s.run.mode,'fixture');assert.equal(s.run.results.length,4);
assert.deepEqual(new Set(s.run.results.map(r=>r.category)),new Set(['Worth reviewing','Conditional','Low priority']));
s=await call('/api/opportunities',{resultKey:s.run.results.find(r=>r.category==='Worth reviewing').key,baseRevision:s.revision});const o=s.opportunities[0];
s=await call('/api/applications/'+o.id,{revision:0,cvVersion:'Fictional demo v1',cvText:'Led AI product evaluation and API platform launches.',coverLetter:'Fictional application for demonstration only.',answers:'Work-country/payroll setup to confirm.',files:[]});
assert.equal(s.applications.length,1);
s=await call('/api/mail/intake',{origin:'test',transportId:'judge-demo-invitation',from:'recruiter@example.com',to:`op-${o.id}@apply.example.com`,subject:'Test interview invitation',text:'We would like to invite you to an interview. Please choose a time.'});
const m=s.messages[0];assert.equal(m.analysis.kind,'interview');assert.equal(s.opportunities[0].stage,'saved');
s=await call('/api/mail/replies/'+m.id,{revision:0,body:'Thank you. Please share available times.'});assert.equal(s.replyDrafts[0].status,'draft');
const denied=await fetch(base+'/api/mail/send',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,503);
console.log(JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),mode:'fictional',results:s.run.results.length,saved:s.opportunities.length,packets:s.applications.length,testMessages:s.messages.length,replySent:false,liveEnabled:s.config.liveReady}));
