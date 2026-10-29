import {textPredicate} from './catalog-query.mjs';import {countryKey} from './vacancy-geography.mjs';
const tokens=value=>(Array.isArray(value)?value:String(value??'').slice(0,1000).split(',')).slice(0,30).map(x=>String(x).trim().slice(0,100).toLowerCase()).filter(Boolean);
export function vacancyPredicate(filters={},at){
 const text=textPredicate('vacancy_search','v','search_text',filters.query,{split:true}),sql=[text.sql],args=[...text.args];
 if(filters.organizationId){sql.push('v.organization_id=?');args.push(filters.organizationId);}
 if(filters.status){sql.push("CASE WHEN v.expires_at IS NOT NULL AND v.expires_at<? THEN 'expired' WHEN v.checked_at<=? THEN 'unknown' ELSE v.observed_status END=?");args.push(at,at-2*86400000,filters.status);}
 function label(kind,values){sql.push(`v.id IN (SELECT vacancy_id FROM vacancy_labels WHERE kind=? AND value IN (${values.map(()=>'?').join(',')}))`);args.push(kind,...values);}
 for(const kind of ['role','level','workMode','employmentType']){const values=tokens(filters[kind]);if(values.length)label(kind,values);}
 const skills=tokens(filters.skills);if(skills.length){if(filters.skillMatch==='any')label('skills',skills);else for(const skill of skills)label('skills',[skill]);}
 if(filters.country)label('country',[countryKey(filters.country)]);
 if(filters.location){sql.push('instr(v.location_text,?)>0');args.push(String(filters.location).trim().slice(0,200).toLowerCase());}
 if(filters.industry){sql.push('v.industry=?');args.push(filters.industry);}
 for(const word of tokens(filters.exclude)){sql.push('instr(v.search_text,?)=0');args.push(word);}
 if(filters.salaryDisclosed==='yes')sql.push('EXISTS(SELECT 1 FROM vacancy_salary s WHERE s.vacancy_id=v.id)');
 if(filters.salaryMin){const minimum=Number(filters.salaryMin);if(!Number.isFinite(minimum)||minimum<0||!filters.currency||!filters.salaryInterval)sql.push('0');else{sql.push('v.id IN (SELECT vacancy_id FROM vacancy_salary WHERE currency=? AND interval=? AND maximum>=?)');args.push(filters.currency,filters.salaryInterval,minimum);}}
 return {sql:sql.join(' AND '),args};
}
