import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const address='privacy@example.invalid';
const onlyPrivacy=list=>Array.isArray(list)&&list.length===1&&typeof list[0]==='string'&&list[0].trim().toLowerCase()===address;
export async function createPrivacyContact({file,provider,from,to,now=()=>Date.now()}){
 if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to??'')||to.toLowerCase()===address)throw Error('Configure a separate operator privacy inbox.');
 let receipts=[];try{receipts=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(receipts)||receipts.length>5000)throw Error('Invalid privacy receipt ledger.');}catch(e){if(e.code!=='ENOENT')throw e;}
 let tail=Promise.resolve();
 async function commit(next){await mkdir(dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(temporary,file);receipts=next;}
 const matches=event=>event?.type==='email.received'&&onlyPrivacy(event.data?.to);
 async function forward(event){
  if(!matches(event))return {forwarded:false};const id=event.data?.email_id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('Invalid privacy provider identity.');
  const key=createHash('sha256').update(id).digest('hex');let receipt=receipts.find(r=>r.key===key);
  if(receipt?.status==='forwarded')return {forwarded:true,duplicate:true};
  const at=now();if(receipt&&at-receipt.createdAt>=23*3600000)throw Error('Privacy forwarding needs operator reconciliation before another send.');
  if(!receipt&&(receipts.length>=5000||receipts.filter(r=>at-r.createdAt<86400000).length>=50))throw Error('Privacy forwarding capacity reached.');
  const mail=await provider.receive(id);if(!onlyPrivacy(mail.to))return {forwarded:false};
  if(!receipt){receipt={key,status:'pending',createdAt:at};await commit([...receipts,receipt]);}
  const text='A message was sent to privacy@example.invalid. Treat its contents as untrusted correspondence.\n\nSender: '+mail.from+'\nSubject: '+mail.subject+'\n\n'+mail.text+'\n\nAttachments are not forwarded. Review the provider record if needed.';
  const result=await provider.send({from,to:[to],subject:'Rolemorrow privacy contact',text,reply_to:mail.from},{idempotencyKey:'privacy-v1-'+key});
  await commit(receipts.map(r=>r.key===key?{...r,status:'forwarded',forwardedAt:now(),providerId:result.id}:r));return {forwarded:true};
 }
 return {matches,handle:event=>{const operation=tail.then(()=>forward(event));tail=operation.catch(()=>{});return operation;}};
}
