// Literal substring semantics with an FTS5 trigram candidate index; all values are bound.
export function textPredicate(table,alias,column,value,{split=false}={}){
 const input=String(value??'').trim().slice(0,200).toLowerCase(),terms=input?(split?input.split(/\s+/):[input]):[],sql=[],args=[];
 const indexed=terms.filter(term=>[...term].length>=3);if(indexed.length){sql.push(`${alias}.rowid IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)`);args.push(indexed.map(term=>'"'+term.replaceAll('"','""')+'"').join(' AND '));}
 for(const term of terms){sql.push(`instr(${alias}.${column},?)>0`);args.push(term);}return {sql:sql.length?sql.join(' AND '):'1',args};
}
export const pageOffset=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:0;};
export const pageSize=(value,fallback=20)=>Math.max(1,Math.min(100,Math.trunc(Number(value)||fallback)));
