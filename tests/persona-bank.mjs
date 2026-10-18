// Original fictional candidates. Not derived from HireWire or owner resumes.
export const version='persona-bank-2026-10-18-v1';
const person=(name,role,facts)=>({name,profile:{facts:facts.map((text,i)=>({id:`f${i+1}`,text})),goal:{roles:role,industries:'software',country:'Portugal',workMode:'any'}}});
export const people={
 api:person('Maya · API product manager','Product Manager',['I owned API integrations for a B2B product.','I interviewed enterprise customers; I have not built product health dashboards.']),
 ml:person('Leon · ML engineer','Machine Learning Engineer',['I trained machine learning models and deployed model-serving APIs.','I implemented model monitoring in Python.']),
 design:person('Amina · product designer','Product Designer',['I conducted user interviews and designed interactive prototypes.','I worked with product managers; I did not own API integrations.']),
 switch:person('Tom · finance-to-product transition','Product Manager',['I owned payment reconciliation and settlement as a finance operations analyst.','I want to move into product management; I have not yet managed API integrations.']),
 junior:person('Sofia · junior product manager','Product Manager',['I ran A/B tests for one checkout feature.','I did not establish an organization-wide experimentation culture.']),
 legacy:person('Alex · telecom platform leader','Product Manager',['I led incremental migration of a telecom monolith into billing and ordering services.','I owned API integrations and built product health dashboards.'])
};
const job=(id,title,text)=>({id,title,url:`https://northstar.example/careers/persona-${id}`,text:`${text} Remote in Portugal.`,countries:['Portugal'],workMode:'remote',salary:null,requirements:[{id:'r1',text,core:true}]});
export const jobs={
 api:job('api','Platform Product Manager','Own API integrations and build product health dashboards.'),
 ml:job('ml','Machine Learning Engineer','Train machine learning models and deploy model-serving APIs.'),
 design:job('design','Product Designer','Conduct user interviews and design interactive prototypes.'),
 finance:job('finance','Payments Product Manager','Own payment reconciliation and settlement.'),
 growth:job('growth','Growth Product Manager','Run A/B tests and establish an organization-wide experimentation culture.'),
 legacy:job('legacy','Platform Product Manager','Lead incremental migration of a telecom monolith into billing and ordering services.')
};
export const cases=[
 ['api','api','partial','aligned'],['api','ml','unknown','different'],
 ['ml','ml','supported','aligned'],['ml','api','unknown','different'],
 ['design','design','supported','aligned'],['design','api','unknown','different'],
 ['switch','finance','supported','aligned'],['switch','api','unknown','aligned'],
 ['junior','growth','partial','aligned'],['junior','legacy','unknown','aligned'],
 ['legacy','legacy','supported','aligned'],['legacy','api','supported','aligned']
].map(([personId,jobId,status,direction])=>({personId,jobId,status,direction}));
