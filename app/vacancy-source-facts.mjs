// Source fields stay separate from profile matching and legal work eligibility.
const strings=value=>(Array.isArray(value)?value:[]).filter(v=>typeof v==='string').slice(0,20);
const list=value=>Array.isArray(value)?value.slice(0,20):value?[value]:[];
const named=value=>typeof value==='string'?value:typeof value?.name==='string'?value.name:'';
const interval=value=>({'1 YEAR':'1 YEAR',YEAR:'1 YEAR',year:'1 YEAR',yearly:'1 YEAR',annual:'1 YEAR','per-year-salary':'1 YEAR','1 MONTH':'1 MONTH',MONTH:'1 MONTH',month:'1 MONTH',monthly:'1 MONTH','per-month-salary':'1 MONTH','1 HOUR':'1 HOUR',HOUR:'1 HOUR',hour:'1 HOUR',hourly:'1 HOUR','per-hour-wage':'1 HOUR'})[value]??'';
export function ashbyVacancyFacts(job){
 const extra=list(job.secondaryLocations),country=job.address?.postalAddress?.addressCountry;
 return {department:job.department,team:job.team,salary:job.compensation?.summaryComponents,employmentType:job.employmentType,workplaceType:job.workplaceType??(job.isRemote===true?'Remote':''),country,locations:[job.location,...extra.map(x=>x?.location)],countries:[country,...extra.map(x=>x?.address?.addressCountry??x?.address?.postalAddress?.addressCountry)]};
}
export function leverVacancyFacts(job){const pay=job.salaryRange;
 return {department:job.categories?.department,team:job.categories?.team,employmentType:job.categories?.commitment,workplaceType:job.workplaceType,country:job.country,countries:[job.country],locations:[job.categories?.location,...strings(job.categories?.allLocations)],salary:pay?[{compensationType:'Salary',currencyCode:pay.currency,interval:interval(pay.interval),minValue:pay.min,maxValue:pay.max}]:[]};
}
export function schemaVacancyFacts(schema){
 const locations=list(schema.jobLocation),addresses=locations.map(p=>p?.address).filter(x=>x&&typeof x==='object');
 const salary=list(schema.baseSalary).filter(x=>x&&typeof x==='object').map(pay=>{const v=pay.value,range=v&&typeof v==='object'?v:{};return {compensationType:'Salary',currencyCode:pay.currency,interval:interval(range.unitText),minValue:typeof v==='number'?v:range.minValue??range.value,maxValue:typeof v==='number'?v:range.maxValue??range.value};});
 const countries=addresses.map(a=>named(a.addressCountry)),names=addresses.map(a=>[a.addressLocality,a.addressRegion,named(a.addressCountry)].filter(x=>typeof x==='string'&&x.trim()).join(', '));
 return {department:named(schema.employmentUnit),locations:names,countries,country:countries[0],employmentTypes:typeof schema.employmentType==='string'?[schema.employmentType]:strings(schema.employmentType),workplaceType:schema.jobLocationType==='TELECOMMUTE'?'Remote':'',applicantLocations:list(schema.applicantLocationRequirements).map(named),salary};
}
