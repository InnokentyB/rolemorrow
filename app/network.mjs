import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Agent,fetch} from 'undici';
function publicAddress(value){
 const ip=value.replace(/^\[|\]$/g,'').toLowerCase();
 if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);}
 if(isIP(ip)===6){const parts=ip.split(':');const first=parseInt(parts[0],16),second=parseInt(parts[1]||'0',16);return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&(second<=0x1ff||second===0xdb8))&&(first&0xfff0)!==0x3ff0;}
 return false;
}
export function validatePublicUrl(value){
 let u;try{u=new URL(value);}catch{throw new Error('Invalid source URL.');}
 const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||!h.includes('.')&&!isIP(h)||isIP(h)&&!publicAddress(h))throw new Error('Unsafe source URL.');
 return u;
}
export async function safeFetch(value,{signal,lookup=dnsLookup,transport=fetch,maxBytes=1024*1024,headers={},method='GET',body}={}){
 const timed=AbortSignal.timeout(20000);const combined=signal?AbortSignal.any([signal,timed]):timed;
 let u=validatePublicUrl(value);
 for(let hop=0;hop<6;hop++){
  combined.throwIfAborted();
  const hostname=u.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await Promise.race([lookup(hostname,{all:true,verbatim:true}),new Promise((_,reject)=>combined.addEventListener('abort',()=>reject(new Error('Source request cancelled or timed out.')),{once:true}))]);
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Unsafe source DNS address.');
  const agent=new Agent({connect:{lookup:(_host,options,cb)=>{const selected=addresses.filter(a=>!options.family||a.family===options.family);if(!selected.length)return cb(new Error('No permitted address.'));if(options.all)cb(null,selected);else cb(null,selected[0].address,selected[0].family);}}});
  try{
   const response=await transport(u.href,{signal:combined,dispatcher:agent,redirect:'manual',headers,method,body});
   if([301,302,303,307,308].includes(response.status)){if(method!=='GET'){await response.body?.cancel();throw new Error('Source POST redirect refused.');}const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('Source redirect missing destination.');u=validatePublicUrl(new URL(location,u).href);continue;}
   if(!response.ok){await response.body?.cancel();throw new Error(`Source request failed (${response.status}).`);}
   if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('Source response exceeds size limit.');}
   const chunks=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.byteLength;if(size>maxBytes){throw new Error('Source response exceeds size limit.');}chunks.push(Buffer.from(chunk));}
   return {text:Buffer.concat(chunks).toString('utf8'),url:u.href,status:response.status};
  }catch(error){if(error.message?.startsWith('Source')||error.message?.startsWith('Unsafe'))throw error;throw new Error('Source request failed or timed out.');}finally{await agent.close();}
 }
 throw new Error('Source redirect limit exceeded.');
}
