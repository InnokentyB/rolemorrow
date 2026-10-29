import {openCatalogDatabase} from './catalog-database.mjs';import {pageOffset,pageSize} from './catalog-query.mjs';import {vacancyPredicate} from './vacancy-query.mjs';
import {normalizeVacancyFacts} from './vacancy-classification.mjs';import {createHash} from 'node:crypto';import {validatePublicUrl} from './network.mjs';import {listingIdentity} from './discovery-coverage.mjs';
const DAY=86400000,clean=(s,n)=>String(s??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').trim().slice(0,n),hash=s=>createHash('sha256').update(s).digest('hex');
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(s)&&Number.isFinite(Date.parse(s))?s:null;
export async function createVacancyCatalog({file,now=()=>Date.now(),database}={}){
 const owned=!database;if(!database&&!file)throw Error('A catalog file or database is required.');database??=await openCatalogDatabase({file:file+'.sqlite',vacanciesFile:file});
 const coverage=id=>{const row=database.get('SELECT data FROM coverage WHERE organization_id=?',[id]);return row?JSON.parse(row.data):null;};
 const schedule=()=>database.meta('schedule',{nextBatchAt:0});
 const view=row=>({...row,status:row.validThrough&&Date.parse(row.validThrough)+(row.validThrough.length===10?DAY:0)<now()?'expired':now()-row.checkedAt>=2*DAY?'unknown':row.observedStatus});
 return {
  database,
  observe:(company,{postings=[],inventory={}}={},options={})=>database.write(()=>{
   const at=now(),known=new Set((inventory.urls??[]).map(listingIdentity)),sources=(inventory.sources??[]).slice(0,20).map(u=>validatePublicUrl(u).href);
   // Touch only this employer's observation metadata, in bounded database pages.
   let after=0;for(;;){const previous=database.query('SELECT rowid,data FROM vacancies WHERE organization_id=? AND rowid>? ORDER BY rowid LIMIT 200',[company.id,after]);if(!previous.length)break;for(const record of previous){const row=JSON.parse(record.data);row.checkedAt=at;if(known.has(row.identity))row.lastSeenAt=at;row.observedStatus=known.has(row.identity)?'active':inventory.complete===true&&sources.length>0&&row.sources.some(s=>sources.includes(s))?'not-listed':'unknown';database.statement('UPDATE vacancies SET checked_at=?,last_seen_at=?,observed_status=?,data=? WHERE id=?').run(at,row.lastSeenAt,row.observedStatus,JSON.stringify(row),row.id);after=record.rowid;}}
   for(const posting of postings){const url=validatePublicUrl(posting.url).href,identity=listingIdentity(url);if(!known.has(identity)&&!(posting.sources??[]).includes(company.careers))throw Error('Posting requires source evidence');const title=clean(posting.title,200),text=clean(posting.text,10000);if(!title||!text)continue;const evidence=(posting.sources??[]).slice(0,20).map(u=>validatePublicUrl(u).href);if(!evidence.length)throw Error('Posting requires source evidence');const data={url,title,text,textTruncated:String(posting.text).length>10000,publishedAt:date(posting.publishedAt),validThrough:date(posting.validThrough),sources:evidence,location:clean(posting.location,300),facts:normalizeVacancyFacts(posting.facts),industryGroup:company.industryGroup??'unknown'};
    const record=database.get('SELECT data,text FROM vacancies WHERE organization_id=? AND identity=?',[company.id,identity]),old=record?database.decodeVacancy(record):null,contentHash=hash(title+'\n'+text),changed=old&&(old.contentHash??hash(old.title+'\n'+old.text))!==contentHash;
    database.putVacancy({...old,...data,id:old?.id??'vac-'+hash(company.id+'\n'+identity).slice(0,32),identity,organizationId:company.id,companyName:company.name,domain:company.domain,contentHash,textFetchedAt:at,firstSeenAt:old?.firstSeenAt??at,lastSeenAt:at,checkedAt:at,changedAt:old?changed?at:old.changedAt:at,observedStatus:'active'});
   }
   const stored=database.get('SELECT count(*) AS count FROM vacancies WHERE organization_id=?',[company.id]).count;
   database.statement('CREATE TEMP TABLE IF NOT EXISTS observed_inventory(identity TEXT PRIMARY KEY)').run();database.statement('DELETE FROM observed_inventory').run();for(const identity of known)database.statement('INSERT INTO observed_inventory(identity) VALUES(?)').run(identity);
   const storedKnown=database.get('SELECT count(*) AS count FROM vacancies WHERE organization_id=? AND identity IN (SELECT identity FROM observed_inventory)',[company.id]).count;
   const report={checkedAt:at,nextRefreshAt:options.nextRefreshAt??at+DAY,complete:inventory.complete===true,knownListings:known.size,stored,truncated:known.size>storedKnown,status:'checked',storageLimited:false};database.putCoverage(company.id,report);return report;
  }),
  fail:(company,options={})=>database.write(()=>{const at=now();database.statement("UPDATE vacancies SET checked_at=?,observed_status='unavailable',data=json_set(data,'$.checkedAt',?,'$.observedStatus','unavailable') WHERE organization_id=?").run(at,at,company.id);database.putCoverage(company.id,{...coverage(company.id),lastAttemptAt:at,nextRefreshAt:options.nextRefreshAt??at+DAY,status:'unavailable'});}),
  list:(filters={})=>{const predicate=vacancyPredicate(filters,now()),offset=pageOffset(filters.offset),limit=pageSize(filters.limit),matching=database.get('SELECT count(*) AS count FROM vacancies v WHERE '+predicate.sql,predicate.args).count;
   const records=database.query('WITH page AS MATERIALIZED (SELECT v.id,v.last_seen_at FROM vacancies v WHERE '+predicate.sql+' ORDER BY v.last_seen_at DESC,v.id LIMIT ? OFFSET ?) SELECT v.data,v.text FROM page p JOIN vacancies v ON v.id=p.id ORDER BY p.last_seen_at DESC,p.id',[...predicate.args,limit,offset]);
   const facets={role:[],level:[],workMode:[],employmentType:[],skills:[]};for(const row of database.query('WITH matched AS MATERIALIZED (SELECT v.id FROM vacancies v WHERE '+predicate.sql+") SELECT l.kind,l.value,count(*) AS count FROM matched m JOIN vacancy_labels l ON l.vacancy_id=m.id WHERE l.kind IN ('role','level','workMode','employmentType','skills') GROUP BY l.kind,l.value ORDER BY l.kind,l.value",predicate.args))facets[row.kind].push({value:row.value,count:row.count});
   return {vacancies:records.map(row=>view(database.decodeVacancy(row))),matching,total:database.get('SELECT count(*) AS count FROM vacancies').count,facets,nextOffset:offset+limit<matching?offset+limit:null,coverage:filters.organizationId?coverage(filters.organizationId):null};
  },
  claimRefreshBatch:intervalMs=>database.write(()=>{if(!Number.isInteger(intervalMs)||intervalMs<3600000)throw Error('Invalid batch interval');if(now()<schedule().nextBatchAt)return false;database.setMeta('schedule',{nextBatchAt:now()+intervalMs});return true;}),
  batchSchedule:schedule,
  nextPassAt:ids=>{let earliest=ids.length?Infinity:now()+DAY;for(let start=0;start<ids.length;start+=1000){const batch=ids.slice(start,start+1000),row=database.get('SELECT min(next_refresh_at) AS deadline,count(*) AS count FROM coverage WHERE organization_id IN ('+batch.map(()=>'?').join(',')+')',batch);earliest=Math.min(earliest,row.count<batch.length?now():row.deadline??now());}return Math.max(schedule().nextBatchAt,earliest);},
  nextPassAtForCatalog:catalog=>{if(catalog.database?.file!==database.file)return Math.max(schedule().nextBatchAt,now()+3600000);const row=database.get('SELECT min(coalesce(c.next_refresh_at,?)) AS deadline FROM organizations o LEFT JOIN coverage c ON c.organization_id=o.id',[now()]);return Math.max(schedule().nextBatchAt,row.deadline??now()+DAY);},
  nextCheckAt:id=>database.get('SELECT next_refresh_at FROM coverage WHERE organization_id=?',[id])?.next_refresh_at??0,
  refreshBoundary:(intervalMs=DAY)=>now()+intervalMs,
  needsRefresh:(id,intervalMs=DAY)=>{const report=coverage(id);return !report||now()>=(report.nextRefreshAt??Math.max(report.checkedAt??0,report.lastAttemptAt??0)+intervalMs);},
  count:()=>database.get('SELECT count(*) AS count FROM vacancies').count,
  close:()=>owned?database.close():Promise.resolve()
 };
}
