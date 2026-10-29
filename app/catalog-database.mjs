// Shared public catalogs only. Private accounts and workspaces never enter this database.
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {mkdir,readFile,chmod,stat} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {classifyVacancy,CLASSIFICATION_VERSION} from './vacancy-classification.mjs';import {countryKey,sourceLocations} from './vacancy-geography.mjs';import {classifyIndustry} from './organization-classification.mjs';
const DAY=86400000,hash=data=>createHash('sha256').update(data).digest('hex');
const schema=`
CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS catalog_migrations(kind TEXT PRIMARY KEY,source_path TEXT NOT NULL,source_hash TEXT,row_count INTEGER NOT NULL,imported_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,domain TEXT NOT NULL UNIQUE,name TEXT NOT NULL,sort_name TEXT NOT NULL,search_text TEXT NOT NULL,industry TEXT NOT NULL,employee_range TEXT,employee_asof INTEGER,last_attempt_at INTEGER,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE INDEX IF NOT EXISTS organization_name ON organizations(sort_name,id);
CREATE INDEX IF NOT EXISTS organization_industry_name ON organizations(industry,sort_name,id);
CREATE INDEX IF NOT EXISTS organization_due ON organizations(last_attempt_at,id);
CREATE INDEX IF NOT EXISTS organization_size_name ON organizations(employee_range,employee_asof,sort_name);
CREATE VIRTUAL TABLE IF NOT EXISTS organization_search USING fts5(search_text,content='organizations',content_rowid='rowid',tokenize='trigram');
CREATE TABLE IF NOT EXISTS vacancies(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,identity TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,search_text TEXT NOT NULL,location_text TEXT NOT NULL,industry TEXT NOT NULL,last_seen_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,expires_at INTEGER,observed_status TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(organization_id,identity)) STRICT;
CREATE INDEX IF NOT EXISTS vacancy_employer_seen ON vacancies(organization_id,last_seen_at DESC,id);
CREATE INDEX IF NOT EXISTS vacancy_seen ON vacancies(last_seen_at DESC,id);
CREATE INDEX IF NOT EXISTS vacancy_status ON vacancies(observed_status,checked_at,expires_at);
CREATE INDEX IF NOT EXISTS vacancy_industry_seen ON vacancies(industry,last_seen_at DESC,id);
CREATE TABLE IF NOT EXISTS vacancy_labels(vacancy_id TEXT NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(vacancy_id,kind,value)) STRICT;
CREATE INDEX IF NOT EXISTS vacancy_label_lookup ON vacancy_labels(kind,value,vacancy_id);
CREATE TABLE IF NOT EXISTS vacancy_salary(vacancy_id TEXT NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,currency TEXT NOT NULL,interval TEXT NOT NULL,minimum REAL NOT NULL,maximum REAL NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS vacancy_salary_lookup ON vacancy_salary(currency,interval,maximum,vacancy_id);
CREATE VIRTUAL TABLE IF NOT EXISTS vacancy_search USING fts5(search_text,content='vacancies',content_rowid='rowid',tokenize='trigram');
CREATE TABLE IF NOT EXISTS coverage(organization_id TEXT PRIMARY KEY,next_refresh_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE INDEX IF NOT EXISTS coverage_due ON coverage(next_refresh_at,organization_id);
`;
export async function openCatalogDatabase({file,organizationsFile,vacanciesFile}={}){
 if(!file)throw Error('A dedicated public catalog database path is required.');await mkdir(dirname(file),{recursive:true,mode:0o700});
 const db=new DatabaseSync(file,{timeout:5000,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false});let closed=false,tail=Promise.resolve();const cached=new Map();
 const statement=sql=>{if(!cached.has(sql))cached.set(sql,db.prepare(sql));return cached.get(sql);};
 const query=(sql,args=[])=>{const s=db.prepare(sql);try{return s.all(...args);}finally{s.close?.();}};
 const get=(sql,args=[])=>{const s=db.prepare(sql);try{return s.get(...args);}finally{s.close?.();}};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 function putOrganization(row){
  if(typeof row.id!=='string'||!row.id||typeof row.domain!=='string'||!row.domain||typeof row.name!=='string'||!row.name)throw Error('Invalid imported organization identity.');
  const old=get('SELECT rowid,search_text FROM organizations WHERE id=?',[row.id]);if(old)statement("INSERT INTO organization_search(organization_search,rowid,search_text) VALUES('delete',?,?)").run(old.rowid,old.search_text);
  const searchText=(row.name+' '+row.domain).toLowerCase();statement(`INSERT INTO organizations(id,domain,name,sort_name,search_text,industry,employee_range,employee_asof,last_attempt_at,data) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET domain=excluded.domain,name=excluded.name,sort_name=excluded.sort_name,search_text=excluded.search_text,industry=excluded.industry,employee_range=excluded.employee_range,employee_asof=excluded.employee_asof,last_attempt_at=excluded.last_attempt_at,data=excluded.data`).run(row.id,row.domain,row.name,row.name.toLowerCase(),searchText,row.industryGroup??classifyIndustry(row.industry),row.employees?.range??null,row.employees?Date.parse(row.employees.asOf):null,row.lastAttemptAt??null,JSON.stringify(row));
  statement('INSERT INTO organization_search(rowid,search_text) VALUES(?,?)').run(get('SELECT rowid FROM organizations WHERE id=?',[row.id]).rowid,searchText);
 }
 function putVacancy(row,{insertOnly=false}={}){
  for(const key of ['id','organizationId','identity','title','text'])if(typeof row[key]!=='string'||!row[key])throw Error('Invalid imported vacancy '+key+'.');
  if(insertOnly&&(get('SELECT id FROM vacancies WHERE id=?',[row.id])||get('SELECT id FROM vacancies WHERE organization_id=? AND identity=?',[row.organizationId,row.identity])))throw Error('Conflicting imported vacancy identities.');
  const labels=classifyVacancy(row),data={...row,classification:labels};delete data.text;
  const locations=sourceLocations(row).join(' ').toLowerCase(),searchText=[row.title,row.companyName??'',row.text,locations].join(' ').toLowerCase();
  const old=get('SELECT rowid,search_text FROM vacancies WHERE id=?',[row.id]);if(old)statement("INSERT INTO vacancy_search(vacancy_search,rowid,search_text) VALUES('delete',?,?)").run(old.rowid,old.search_text);
  const expiry=row.validThrough?Date.parse(row.validThrough)+(row.validThrough.length===10?DAY:0):null;
  statement(`INSERT INTO vacancies(id,organization_id,identity,title,text,search_text,location_text,industry,last_seen_at,checked_at,expires_at,observed_status,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,title=excluded.title,text=excluded.text,search_text=excluded.search_text,location_text=excluded.location_text,industry=excluded.industry,last_seen_at=excluded.last_seen_at,checked_at=excluded.checked_at,expires_at=excluded.expires_at,observed_status=excluded.observed_status,data=excluded.data`).run(row.id,row.organizationId,row.identity,row.title,row.text,searchText,locations,row.industryGroup??'unknown',row.lastSeenAt??0,row.checkedAt??0,Number.isFinite(expiry)?expiry:null,row.observedStatus??'unknown',JSON.stringify(data));
  statement('INSERT INTO vacancy_search(rowid,search_text) VALUES(?,?)').run(get('SELECT rowid FROM vacancies WHERE id=?',[row.id]).rowid,searchText);
  statement('DELETE FROM vacancy_labels WHERE vacancy_id=?').run(row.id);
  const dimensions={role:labels.roles,level:labels.levels,workMode:labels.workModes,employmentType:labels.employmentTypes,skills:labels.skills,country:labels.countries.map(countryKey)};
  for(const [kind,values]of Object.entries(dimensions))for(const value of new Set(values))statement('INSERT INTO vacancy_labels(vacancy_id,kind,value) VALUES(?,?,?)').run(row.id,kind,value);
  statement('DELETE FROM vacancy_salary WHERE vacancy_id=?').run(row.id);for(const salary of row.facts?.salary??[])statement('INSERT INTO vacancy_salary(vacancy_id,currency,interval,minimum,maximum) VALUES(?,?,?,?,?)').run(row.id,salary.currency,salary.interval,salary.min,salary.max);
 }
 const putCoverage=(id,data)=>statement('INSERT INTO coverage(organization_id,next_refresh_at,data) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET next_refresh_at=excluded.next_refresh_at,data=excluded.data').run(id,data.nextRefreshAt??Math.max(data.checkedAt??0,data.lastAttemptAt??0)+DAY,JSON.stringify(data));
 const meta=(key,fallback)=>{const row=get('SELECT value FROM catalog_meta WHERE key=?',[key]);return row?JSON.parse(row.value):fallback;};
 const setMeta=(key,value)=>statement('INSERT INTO catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
 async function prepareMigration(kind,path){if(!path)return;let source=null;try{if((await stat(path)).size>256*1024*1024)throw Error('Legacy migration source exceeds one-off budget.');source=await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  const digest=source?hash(source):null,prior=get('SELECT * FROM catalog_migrations WHERE kind=?',[kind]);if(prior){if(source&&prior.source_hash!==digest)throw Error('Legacy catalog source changed after import; reconcile before continuing.');return;}
  const data=source?JSON.parse(source):null,rows=data?.[kind]??[];if(source&&(!data||data.schema!==1||!Array.isArray(data[kind])))throw Error('Invalid legacy catalog source.');
  return ()=>{if(get('SELECT kind FROM catalog_migrations WHERE kind=?',[kind]))return;if(source&&get('SELECT count(*) AS count FROM '+kind).count)throw Error('Refusing to merge legacy catalog into an existing database.');
   if(kind==='organizations')for(const row of rows){if(get('SELECT id FROM organizations WHERE id=? OR domain=?',[row.id,row.domain]))throw Error('Conflicting imported organization identities.');putOrganization(row);}else{for(const row of rows)putVacancy(row,{insertOnly:true});for(const [id,report]of Object.entries(data?.coverage??{}))putCoverage(id,report);if(data){const slot=data.schedule?.nextBatchAt??0;if(!Number.isFinite(slot)||slot<0)throw Error('Invalid imported collection schedule.');setMeta('schedule',{nextBatchAt:slot});}}
   statement('INSERT INTO catalog_migrations(kind,source_path,source_hash,row_count,imported_at) VALUES(?,?,?,?,?)').run(kind,resolve(path),digest,rows.length,Date.now());
  };
 }
 try{
  const applicationId=get('PRAGMA application_id').application_id;if(applicationId!==0&&applicationId!==0x524d4341||applicationId===0&&get("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").count>0)throw Error('Refusing to change an unrelated catalog database application.');
  if(db.prepare('PRAGMA user_version').get().user_version>1)throw Error('Unsupported catalog database version.');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=1000; PRAGMA cache_size=-16384;');transaction(()=>{db.exec(schema);db.exec('PRAGMA user_version=1; PRAGMA application_id=1380795201');});await chmod(file,0o600);for(const suffix of ['-wal','-shm'])try{await chmod(file+suffix,0o600);}catch(error){if(error.code!=='ENOENT')throw error;}
  const importOrganizations=await prepareMigration('organizations',organizationsFile),importVacancies=await prepareMigration('vacancies',vacanciesFile);transaction(()=>{importOrganizations?.();importVacancies?.();});
  if(meta('classificationVersion',null)!==CLASSIFICATION_VERSION){transaction(()=>{let after=0;for(;;){const batch=query('SELECT rowid,data,text FROM vacancies WHERE rowid>? ORDER BY rowid LIMIT 200',[after]);if(!batch.length)break;for(const row of batch){putVacancy({...JSON.parse(row.data),text:row.text});after=row.rowid;}}setMeta('classificationVersion',CLASSIFICATION_VERSION);});}
 }catch(error){db.close();throw error;}
 return {file,query,get,statement,transaction,putOrganization,putVacancy,putCoverage,meta,setMeta,decodeVacancy:row=>({...JSON.parse(row.data),text:row.text}),
  write(fn){const promise=tail.then(()=>{if(closed)throw Error('Catalog database closed.');return transaction(fn);});tail=promise.catch(()=>{});return promise;},
  integrity:()=>{const result=get('PRAGMA integrity_check').integrity_check;if(result!=='ok')return result;if(query('PRAGMA foreign_key_check').length)throw Error('Catalog foreign-key integrity failed.');db.exec("INSERT INTO vacancy_search(vacancy_search,rank) VALUES('integrity-check',1); INSERT INTO organization_search(organization_search,rank) VALUES('integrity-check',1);");return result;},
  async backup(destination){await tail;if(resolve(destination)===resolve(file))throw Error('Backup must use a separate path.');try{await stat(destination);throw Error('Refusing to overwrite an existing backup.');}catch(error){if(error.code!=='ENOENT')throw error;}await sqliteBackup(db,destination);await chmod(destination,0o600);},
  async close(){await tail;if(!closed){closed=true;db.close();}}
 };
}
