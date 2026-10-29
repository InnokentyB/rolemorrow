import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../app/server.mjs';
import {chromium} from './browser.mjs';
const dir=await mkdtemp(join(tmpdir(),'native-mail-ui-'));
const server=createServer({storeFile:join(dir,'state.json'),env:{}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Applications',exact:true}).click();
 await page.locator('#application-send').waitFor({state:'attached'});
 assert.equal(await page.locator('#application-send').isDisabled(),true);
 assert.match(await page.locator('#mail-transport-status').textContent(),/not connected|disabled|not configured/i);
 await page.getByRole('button',{name:'Inbox',exact:true}).click();
 await page.getByRole('heading',{name:'Email notifications',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log('Native mail UI readiness gating, notifications surface and mobile PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}

// A real-role workspace and verified inbound message are synthetic fixtures;
// the injected provider never makes a network request.
const {externalListing}=await import('../app/url-intake.mjs');
const {saveOpportunity}=await import('../app/opportunities.mjs');
const {mailAction}=await import('../app/mail.mjs');
const {receiveResend}=await import('../app/mail-transport.mjs');
const {writeFile}=await import('node:fs/promises');
const nativeDir=await mkdtemp(join(tmpdir(),'native-mail-ready-ui-'));
const seed={revision:0,profile:null,companies:[],run:{mode:'manual',id:'seed',status:'partial',results:[],coverage:[],startedAt:new Date().toISOString()},history:[],opportunities:[],applications:[],messages:[],replyDrafts:[],notifications:[],mailDispatches:[],mailEvents:[],mailSchema:1};
const job=saveOpportunity(seed,await externalListing({url:'https://employer.example/jobs/pm',title:'Product Manager',company:'Example employer'}));
mailAction(seed,'/api/applications/'+job.id,{revision:0,cvVersion:'Reviewed CV v1',cvText:'Confirmed product experience.',coverLetter:'Saved supporting letter.',answers:'Confirmed answers.',files:[]});
receiveResend(seed,{transportId:'inbound-fixture',messageId:'<invitation@employer.example>',from:'test@example.com',to:`op-${job.id}@apply.rolemorrow.com`,subject:'Interview invitation',text:'We invite you to an interview. Please choose a time.',textSource:'html-extracted',textTruncated:true,attachments:[{id:'meta-attachment',name:'Interview brief.pdf',type:'application/pdf',size:2048,downloaded:false}],files:[]},{replyDomain:'apply.rolemorrow.com'});
const mailCalls=[];
await writeFile(join(nativeDir,'state.json'),JSON.stringify(seed));
const configured=createServer({storeFile:join(nativeDir,'state.json'),env:{MAIL_ALLOW_SEND:'1',RESEND_API_KEY:'fixture-not-a-key',MAIL_FROM:'applications@apply.rolemorrow.com',MAIL_REPLY_DOMAIN:'apply.rolemorrow.com',MAIL_RECIPIENT_ALLOWLIST:'test@example.com'},mailProvider:{send:async(payload,options)=>{mailCalls.push({payload:structuredClone(payload),options:structuredClone(options)});if(mailCalls.length===1)throw Error('Synthetic uncertain provider response');return {id:'provider-'+mailCalls.length};}}});
await new Promise(r=>configured.listen(0,'127.0.0.1',r));const nativeBrowser=await chromium.launch({headless:true});
try{
 const page=await nativeBrowser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
 const base=`http://127.0.0.1:${configured.address().port}`;
 await page.goto(base);await page.getByRole('button',{name:'Applications',exact:true}).click();
 assert.match(await page.locator('#mail-transport-status').textContent(),/Sending from/);
 assert.equal(await page.locator('#application-stale').isHidden(),true);assert.match(await page.locator('#application-send-help').textContent(),/review.*confirm|confirm.*review/i);
 await page.getByText('Interview brief.pdf · application/pdf · 2 KiB · not downloaded; open in Resend',{exact:true}).waitFor();await page.getByText('Text extracted from HTML. Review the original email in Resend before relying on formatting or omitted content.',{exact:true}).waitFor();await page.getByText('Email content is truncated. Review the complete original email in Resend.',{exact:true}).waitFor();assert.equal(await page.locator('a').filter({hasText:'Interview brief.pdf'}).count(),0);
 await page.getByLabel('Employer email address',{exact:true}).fill('test@example.com');await page.getByLabel('Application email subject',{exact:true}).fill('Application: Product Manager');await page.getByLabel('Application email body',{exact:true}).fill('Please find my reviewed application attached.');
 assert.equal(await page.locator('#application-send').isDisabled(),true);assert.equal(mailCalls.length,0);
 await page.getByLabel('Employer email address',{exact:true}).fill('blocked@example.com');await page.locator('#application-email-confirm').check();await page.locator('#application-send').click();await page.getByRole('status').filter({hasText:'outside the configured test allowlist'}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.id),'notice');assert.equal(await page.getByLabel('Application email body',{exact:true}).inputValue(),'Please find my reviewed application attached.');assert.equal(mailCalls.length,0);await page.getByLabel('Employer email address',{exact:true}).fill('test@example.com');
 await page.locator('#application-email-confirm').check();assert.equal(await page.locator('#application-send').isEnabled(),true);
 await page.locator('#application-send').click();await page.locator('.delivery-status').filter({hasText:'Outcome unknown'}).waitFor();assert.equal(mailCalls.length,1);
 await page.getByLabel('CV text',{exact:true}).fill('Updated later experience.');await page.getByRole('button',{name:'Save application packet',exact:true}).click();await page.getByRole('status').filter({hasText:'Application packet saved'}).waitFor();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Retry the same email snapshot',exact:true}).click();await page.locator('.delivery-status').filter({hasText:'Accepted by provider; delivery not confirmed'}).waitFor();
 assert.equal(mailCalls.length,2);assert.deepEqual(mailCalls[0],mailCalls[1]);assert.equal(await page.getByRole('button',{name:'Retry the same email snapshot',exact:true}).count(),0);
 await page.getByText('Prepare reply',{exact:true}).click();await page.getByLabel('Reply body',{exact:true}).fill('Thank you. Please share the interview format.');await page.getByRole('button',{name:'Save reply draft',exact:true}).click();await page.getByRole('status').filter({hasText:'Reply draft saved'}).waitFor();await page.locator('#reply-send-confirm').check();await page.locator('#reply-send').click();await page.getByRole('status').filter({hasText:'Reply email recorded'}).waitFor();assert.equal(mailCalls.length,3);await mkdir('.impeccable/review',{recursive:true});await page.screenshot({path:'.impeccable/review/native-mail-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Inbox',exact:true}).click();const before=await(await page.request.get(base+'/api/state')).json();await page.getByRole('button',{name:'Mark notification read',exact:true}).click();await page.getByRole('status').filter({hasText:'Notification updated.'}).waitFor();await page.getByRole('button',{name:'Mark notification unread',exact:true}).waitFor();await page.waitForFunction(()=>document.activeElement?.textContent==='Mark notification unread');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Mark notification unread');const after=await(await page.request.get(base+'/api/state')).json();assert.equal(after.messages[0].task.done,before.messages[0].task.done);assert.equal(after.opportunities[0].stage,before.opportunities[0].stage);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'.impeccable/review/native-mail-mobile.png',fullPage:true});
 console.log('Native mail UI synthetic send/retry immutable snapshot, saved reply, notification/task separation desktop/mobile PASS');
}finally{await nativeBrowser.close();await new Promise(r=>configured.close(r));await rm(nativeDir,{recursive:true,force:true});}
