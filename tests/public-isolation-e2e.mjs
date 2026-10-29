import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from './browser.mjs';
import {createPublicServer} from '../app/public-server.mjs';
import {profile} from './fixtures.mjs';
const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`,dir=await mkdtemp(join(tmpdir(),'public-isolation-ui-')),outbox=[],password='Synthetic-isolation-password-2026!';
const server=await createPublicServer({storeDir:dir,env:{PUBLIC_ORIGIN:base,PUBLIC_ALLOW_HTTP_LOOPBACK:'1',PUBLIC_REGISTRATION_ENABLED:'1'},sendAccountMail:async m=>outbox.push(m)});
await new Promise(r=>server.listen(port,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try{
 const a=await browser.newContext(),b=await browser.newContext();
 async function account(context,email){
  const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(base+'/account');
  await page.locator('#account-navigation [data-account-panel="register"]').click();await page.locator('#register-name').fill(email);await page.locator('#register-email').fill(email);await page.locator('#register-password').fill(password);await page.locator('#register-terms').check();await page.locator('#register-privacy').check();await page.locator('#register-form button').click();await page.getByRole('status').filter({hasText:'Check your email'}).waitFor();
  const mail=outbox.find(m=>m.to===email);assert.ok(mail);await page.goto(mail.text.match(/http:\/\/[^\s]+\/account\?verify=[^\s]+/)[0]);await page.getByRole('button',{name:'Verify email address',exact:true}).click();await page.getByText('Email verified. Sign in with your password.',{exact:true}).waitFor();
  await page.locator('#login-email').fill(email);await page.locator('#login-password').fill(password);await page.locator('#login-form button').click();await page.getByText('Signed in. Open your workspace when you are ready.',{exact:true}).waitFor();return page;
 }
 const pa=await account(a,'isolation-a@example.com'),pb=await account(b,'isolation-b@example.com');
 async function post(context,path,data){const response=await context.request.post(base+path,{data,headers:{Origin:base}});assert.equal(response.status(),200,await response.text());return response.json();}
 for(const [context,marker] of [[a,'Private Alice'],[b,'Private Bob']])await post(context,'/api/profile',{...profile,facts:[{id:'f1',text:marker+' led product launches.'}],baseRevision:0});
 await pa.goto(base);await pb.goto(base);assert.equal(await pa.locator('#facts').inputValue(),'Private Alice led product launches.');assert.equal(await pb.locator('#facts').inputValue(),'Private Bob led product launches.');
 await pa.getByRole('button',{name:'Saved jobs',exact:true}).click();await pa.locator('#external-url').fill('https://employer.example/jobs/alice');await pa.locator('#external-title').fill('Private Alice role');await pa.getByRole('button',{name:'Save vacancy link',exact:true}).click();await pa.getByRole('status').filter({hasText:'Vacancy saved as unverified'}).waitFor();
 const state=await(await a.request.get(base+'/api/state')).json(),opportunity=state.opportunities[0];
 await pa.getByRole('button',{name:'Applications',exact:true}).click();await pa.locator('#cv-version').fill('Private Alice CV');await pa.locator('#cv-text').fill('Private Alice packet text');await pa.locator('#cv-files').setInputFiles({name:'private-a.txt',mimeType:'text/plain',buffer:Buffer.from('Private Alice attachment')});await pa.getByRole('button',{name:'Save application packet',exact:true}).click();await pa.getByRole('status').filter({hasText:'Application packet saved'}).waitFor();
 const saved=await(await a.request.get(base+'/api/state')).json(),file=saved.applications[0].files[0],filePath='/api/application-files/'+opportunity.id+'/'+file.id;
 assert.equal(await(await a.request.get(base+filePath)).text(),'Private Alice attachment');assert.equal((await b.request.get(base+filePath)).status(),404);
 assert.equal((await b.request.post(base+'/api/applications/'+opportunity.id,{headers:{Origin:base},data:{revision:0,cvVersion:'Injected',cvText:'Injected',coverLetter:'',answers:'',files:[]}})).status(),404);
 await pb.getByRole('button',{name:'Saved jobs',exact:true}).click();assert.equal(await pb.locator('.saved-job').count(),0);await pb.getByRole('button',{name:'Applications',exact:true}).click();assert.equal(await pb.locator('#application-empty').isVisible(),true);assert.ok(!(await pb.locator('body').innerText()).includes('Private Alice'));
 const before=await(await b.request.get(base+'/api/state')).json();assert.equal(before.applications.length,0);assert.equal(before.profile.facts[0].text,'Private Bob led product launches.');
 await pa.goto(base+'/account');await pa.getByRole('button',{name:'Sign out',exact:true}).click();await pa.getByText('Signed out.',{exact:true}).waitFor();assert.equal((await a.request.get(base+filePath)).status(),401);assert.equal((await b.request.get(base+'/api/account/me')).status(),200);
 await pa.locator('#login-email').fill('isolation-a@example.com');await pa.locator('#login-password').fill(password);await pa.locator('#login-form button').click();await pa.getByText('Signed in. Open your workspace when you are ready.',{exact:true}).waitFor();await pa.getByText('Delete your account',{exact:true}).click();await pa.getByLabel('Confirm your password',{exact:true}).fill(password);await pa.locator('#delete-account-confirm').check();await pa.getByRole('button',{name:'Delete account and workspace',exact:true}).click();await pa.getByText('Your account and its workspace have been deleted.',{exact:true}).waitFor();
 assert.equal((await a.request.get(base+'/api/state')).status(),401);assert.equal((await a.request.get(base+filePath)).status(),401);await pb.goto(base);assert.equal(await pb.locator('#facts').inputValue(),'Private Bob led product launches.');const after=await(await b.request.get(base+'/api/state')).json();assert.deepEqual(after,before);
 console.log('Public browser isolation PASS: separate cookies, private profiles/packets/files, forbidden mutation, independent logout and deletion. Captured synthetic mail only.');
}finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
