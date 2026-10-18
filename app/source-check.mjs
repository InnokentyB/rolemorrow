import{hash}from'./domain.mjs';import{textFromHtml}from'./discovery.mjs';import{safeFetch}from'./network.mjs';
export async function checkSavedSource(opportunity,{read=safeFetch,signal}={}){
 const original=new URL(opportunity.snapshot.url),checkedAt=new Date().toISOString();
 try{
 const page=await read(original.href,{signal});const target=new URL(page.url);if(target.origin!==original.origin||target.pathname.replace(/\/$/,'')!==original.pathname.replace(/\/$/,''))throw Error('Source redirected away from the saved posting.');
 const text=textFromHtml(page.text);if(text.length<40||/enable javascript|checking your browser|access denied|verify you are human/i.test(text))throw Error('Source content unavailable.');
 const contentHash=hash(text),excerpt=text.slice(0,1200);const previous=opportunity.lastReadableSourceCheck??opportunity.sourceCheckHistory?.findLast(v=>v.contentHash);
 if(/(?:position|job|vacancy|role) (?:has been filled|is no longer available|is no longer accepting|is closed)|no longer accepting applications/i.test(text))return{checkedAt,status:'possibly-closed',contentHash,excerpt,note:'The page contains closure wording. Verify the original source; no stage was changed.'};
 if(!text.toLowerCase().includes(opportunity.snapshot.title.toLowerCase()))throw Error('Saved role title not visible in the retrieved text.');
 const normalize=value=>textFromHtml(value).toLowerCase();const missingSavedRequirements=(opportunity.snapshot.requirements??[]).filter(r=>r.core&&!normalize(text).includes(normalize(r.text))).slice(0,8).map(r=>r.text.slice(0,500));
 if(!previous&&missingSavedRequirements.length)return{checkedAt,status:'changed',contentHash,excerpt,missingSavedRequirements,note:'Saved core requirement wording was not found on the readable page. Review it: wording or formatting may have changed; no new fit assessment was made.'};
 return {checkedAt,status:previous?(previous.contentHash===contentHash?'unchanged':'changed'):'baseline',contentHash,excerpt,note:previous?(previous.contentHash===contentHash?'No text change since the previous successful check.':'Source page text changed. Review the original requirements and packet; this is not a new fit assessment.'):'First readable page baseline recorded. It is not a comparison with the original extracted requirements.'};
 }catch(error){return{checkedAt,status:/^Source request failed \((?:404|410)\)\.$/.test(error.message)?'not-found':'unavailable',note:/^Source request failed \((?:404|410)\)\.$/.test(error.message)?'The saved URL returned 404/410. This does not prove the employer closed the vacancy.':'Could not verify this posting. Access errors, dynamic pages and redirects do not prove closure.'};}
}
