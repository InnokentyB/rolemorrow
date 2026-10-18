import {chromium} from './browser.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from '../app/server.mjs';
import {providers,companies} from './fixtures.mjs';
const dir=await mkdtemp(join(tmpdir(),'career-browser-'));
const s=createServer({providers:providers(),storeFile:join(dir,'state.json')});await new Promise(r=>s.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${s.address().port}`);
 await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByRole('status').filter({hasText:'Add at least one experience fact'}).waitFor({timeout:3000});
 await page.getByRole('button',{name:'Use fictional example',exact:true}).click();
 await page.getByLabel('Company sources').fill(companies.map(c=>`${c.name} | ${c.homepage} | ${c.careers} | ${c.industry}`).join('\n'));
 await page.getByRole('button',{name:'Save companies',exact:true}).click();
 await page.getByRole('button',{name:'Check selected companies',exact:true}).click();
 await page.getByRole('heading',{name:'Senior Product Manager',exact:true}).waitFor();
 await page.locator('#results').getByText('Worth reviewing',{exact:true}).first().waitFor();
 await page.getByText('No vacancies found in the checked source.').waitFor();
 await page.getByText('Review evidence',{exact:true}).click();
 await page.getByText('AI product evaluation',{exact:true}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'Senior Product Manager',exact:true}).waitFor();
 await page.getByRole('button',{name:'Profile & goal',exact:true}).click();await page.getByLabel('Target roles').fill('Director');await page.getByRole('button',{name:'Save profile',exact:true}).click();
 await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByText('Inputs or assessment rules changed. Run a new check before using these recommendations.').waitFor();
 // T22: narrow layout and keyboard path, no overflow.
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Profile & goal',exact:true}).click();
 await page.getByLabel('Target roles').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'industries');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mkdir('.impeccable/review',{recursive:true});await page.screenshot({path:'.impeccable/review/mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Results',exact:true}).click();await page.screenshot({path:'.impeccable/review/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Delete local data',exact:true}).click();await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await page.getByRole('status').filter({hasText:'Local profile and search data deleted.'}).waitFor();await page.reload();assert.equal(await page.getByLabel('Target roles').inputValue(),'');assert.deepEqual(errors,[]);
 console.log('T01/T02/T03/T05/T14/T20/T22 browser journey PASS');
}finally{await browser.close();await new Promise(r=>s.close(r));}
