import {validatePublicUrl,safeFetch} from './network.mjs';
import {textFromHtml} from './discovery.mjs';
import {cleanText,hash,id} from './domain.mjs';

// A supplied URL proves neither employer ownership nor vacancy availability.
// Fetching uses the existing DNS-pinned, redirect-validated public-source reader.
export async function externalListing(body,{read=safeFetch}={}){
 const url=validatePublicUrl(body.url).href;
 let title=cleanText(body.title??'',250),text=cleanText(body.text??'',40000);
 const company=cleanText(body.company??'',100)||new URL(url).hostname;
 let readNote='Link saved without an external request. Add the title and description when available.';
 if(body.readSource===true){
  try{
   const page=await read(url,{signal:AbortSignal.timeout(22000)});
   const target=validatePublicUrl(page.url);
   if(target.origin!==new URL(url).origin||target.pathname.replace(/\/$/,'')!==new URL(url).pathname.replace(/\/$/,''))throw Error('Redirected away from posting.');
   const extracted=textFromHtml(page.text);
   if(extracted.length<40||/enable javascript|checking your browser|access denied|verify you are human/i.test(extracted))throw Error('Unreadable page.');
   title ||= textFromHtml(page.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'').slice(0,250);
   text ||= extracted.slice(0,40000);
   readNote='Public page retrieved; employer ownership, availability and requirements remain unverified. No automated matching ran.';
  }catch{readNote='Page could not be read. Link saved; paste the public description or review the source. This does not mean the vacancy is closed.';}
 }
 const key='external-'+id();
 return {id:key,key,title:title||'Saved vacancy link',company,text,url,requirements:[],countries:[],workMode:'unknown',salary:null,assessment:null,category:null,error:readNote,source:{url,hash:hash(text),checkedAt:new Date().toISOString(),authority:'user-supplied unverified',linkedFrom:null,intakeMethod:body.readSource===true?'public-url-read':'url-only'}};
}
