import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAccountStore} from '../app/accounts.mjs';
async function setup(t,{clock=()=>Date.now(),send}={}){const dir=await mkdtemp(join(tmpdir(),'rolemorrow-accounts-'));const mails=[];const file=join(dir,'private','accounts.json');const store=createAccountStore({file,origin:'https://rolemorrow.example',now:clock,sendAccountMail:send??(async m=>mails.push(m))});t.after(()=>rm(dir,{recursive:true,force:true}));return {store,file,mails};}
const credentials={email:'Owner@Example.com',password:'correct horse battery staple',name:'Owner'};
const token=(m,kind)=>new URL(m.text.match(/https:\/\/\S+/)[0]).searchParams.get(kind);
async function verified(h){assert.deepEqual(await h.store.register(credentials),{ok:true});await h.store.verify({token:token(h.mails.at(-1),'verify')});return h.store.login(credentials);}
test('AC01 registration requires email ownership, durable hashes only, and returns no account enumeration',async t=>{
 const h=await setup(t);assert.deepEqual(await h.store.register(credentials),{ok:true});assert.deepEqual(await h.store.register({...credentials,email:'owner@example.com'}),{ok:true});await assert.rejects(h.store.login(credentials),e=>e.status===401);
 const verifyToken=token(h.mails[0],'verify');await h.store.verify({token:verifyToken});const result=await h.store.login(credentials);assert.equal(result.user.email,'owner@example.com');assert.equal(result.user.verified,true);assert.match(result.user.mailboxTag,/^[a-f0-9]{12}$/);assert.ok(result.sessionToken);assert.equal((await h.store.authenticate(result.sessionToken)).user.id,result.user.id);const disk=await readFile(h.file,'utf8');assert.equal(disk.includes(credentials.password),false);assert.equal(disk.includes(verifyToken),false);assert.equal(disk.includes(result.sessionToken),false);assert.equal((await stat(h.file)).mode&0o777,0o600);assert.equal((await stat(join(h.file,'..'))).mode&0o777,0o700);
 assert.deepEqual(Object.keys(result.user).sort(),['email','id','mailboxTag','name','verified']);await assert.rejects(h.store.verify({token:verifyToken}));
});
test('AC02 password resets are generic, single-use and revoke all sessions',async t=>{
 const h=await setup(t);const login=await verified(h);assert.deepEqual(await h.store.requestReset({email:'missing@example.com'}),{ok:true});assert.deepEqual(await h.store.requestReset({email:'OWNER@example.com'}),{ok:true});const reset=token(h.mails.at(-1),'reset');await h.store.reset({token:reset,password:'new replacement password'});assert.equal(await h.store.authenticate(login.sessionToken),null);await assert.rejects(h.store.login(credentials));const next=await h.store.login({...credentials,password:'new replacement password'});assert.equal(next.user.id,login.user.id);await assert.rejects(h.store.reset({token:reset,password:'another replacement password'}));
});
test('AC03 sessions expire after seven days, tokens after thirty minutes, logout revokes',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now});await h.store.register(credentials);const verify=token(h.mails[0],'verify');now+=30*60*1000;await assert.rejects(h.store.verify({token:verify}));await h.store.register(credentials);await h.store.verify({token:token(h.mails.at(-1),'verify')});const one=await h.store.login(credentials);await h.store.logout(one.sessionToken);assert.equal(await h.store.authenticate(one.sessionToken),null);const two=await h.store.login(credentials);now+=7*86400000;assert.equal(await h.store.authenticate(two.sessionToken),null);
});
test('AC04 concurrent registration/login mutations preserve all users and unique salts',async t=>{
 const h=await setup(t);await Promise.all(Array.from({length:4},(_,i)=>h.store.register({...credentials,email:`owner${i}@example.com`})));assert.equal((await h.store.listUsers()).length,4);for(const m of h.mails)await h.store.verify({token:token(m,'verify')});const logins=await Promise.all(Array.from({length:4},(_,i)=>h.store.login({...credentials,email:`owner${i}@example.com`})));assert.equal(new Set(logins.map(v=>v.user.id)).size,4);for(const l of logins)assert.ok(await h.store.authenticate(l.sessionToken));const data=JSON.parse(await readFile(h.file));assert.equal(new Set(data.users.map(u=>u.passwordSalt)).size,4);assert.equal(new Set(data.users.map(u=>u.mailboxTag)).size,4);
});
test('AC05 failed mail transport leaves pending account recoverable by registration retry',async t=>{
 const mails=[];let fail=true;const h=await setup(t,{send:async m=>{if(fail)throw Error('provider secret');mails.push(m);}});assert.deepEqual(await h.store.register(credentials),{ok:true});fail=false;assert.deepEqual(await h.store.register(credentials),{ok:true});await h.store.verify({token:token(mails.at(-1),'verify')});assert.equal((await h.store.login(credentials)).user.verified,true);
});
test('AC06 deletion requires current session and password and revokes identity',async t=>{
 const h=await setup(t);const login=await verified(h);await assert.rejects(h.store.deleteAccount(login.sessionToken,{password:'wrong password'}));assert.ok(await h.store.authenticate(login.sessionToken));assert.deepEqual(await h.store.deleteAccount(login.sessionToken,{password:credentials.password}),{ok:true});assert.equal(await h.store.authenticate(login.sessionToken),null);assert.deepEqual(await h.store.listUsers(),[]);await assert.rejects(h.store.login(credentials));
});
test('AC07 malformed emails, passwords and names fail without persisting an account',async t=>{
 const h=await setup(t);for(const change of [{password:'short'},{password:'A'.repeat(129)},{email:'a@b.com\r\nBcc:x@y.com'},{name:'A'.repeat(101)}])await assert.rejects(h.store.register({...credentials,...change}));assert.deepEqual(await h.store.listUsers(),[]);
});
test('AC08 concurrent sessions are capped without evicting live sessions and survive reload',async t=>{
 const h=await setup(t);await verified(h);const results=await Promise.allSettled(Array.from({length:11},()=>h.store.login(credentials)));assert.equal(results.filter(r=>r.status==='fulfilled').length,9);assert.equal(results.filter(r=>r.status==='rejected').length,2);
 const sessions=results.filter(r=>r.status==='fulfilled').map(r=>r.value.sessionToken);for(const raw of sessions)assert.ok(await h.store.authenticate(raw));const restored=createAccountStore({file:h.file,origin:'https://rolemorrow.example'});assert.equal((await restored.authenticate(sessions[0])).user.email,'owner@example.com');assert.deepEqual(await restored.listUsers(),await h.store.listUsers());
});
test('AC09 concurrent use of one reset token permits exactly one password change',async t=>{
 const h=await setup(t);await verified(h);await h.store.requestReset({email:credentials.email});const raw=token(h.mails.at(-1),'reset');const results=await Promise.allSettled(['replacement alpha password','replacement beta password'].map(password=>h.store.reset({token:raw,password})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await h.store.listUsers()).length,1);
});
test('AC10 email owner signup cannot inherit an attacker pre-registered password',async t=>{
 const h=await setup(t);await h.store.register({...credentials,password:'attacker pre-registration password',name:'Attacker'});await h.store.register(credentials);await h.store.verify({token:token(h.mails.at(-1),'verify')});const login=await h.store.login(credentials);assert.equal(login.user.name,'Owner');await assert.rejects(h.store.login({...credentials,password:'attacker pre-registration password'}));
});
test('AC11 verification and reset tokens cannot cross purposes and invalid sessions reveal no identity',async t=>{
 const h=await setup(t);await h.store.register(credentials);const raw=token(h.mails[0],'verify');await assert.rejects(h.store.reset({token:raw,password:'replacement secure password'}));assert.equal(await h.store.authenticate('invalid'),null);assert.deepEqual(await h.store.logout('invalid'),{ok:true});await h.store.verify({token:raw});await h.store.requestReset({email:credentials.email});await assert.rejects(h.store.verify({token:token(h.mails.at(-1),'reset')}));
});

test('AC12 provider quotas survive reload and serialize concurrent consumption',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now});const attempts=await Promise.allSettled(Array.from({length:5},()=>h.store.consumeQuota('global','paid-search',3,60000)));assert.equal(attempts.filter(v=>v.status==='fulfilled').length,3);assert.equal(attempts.filter(v=>v.status==='rejected'&&v.reason.status===429).length,2);
 const restored=createAccountStore({file:h.file,origin:'https://rolemorrow.example',now:()=>now});await assert.rejects(restored.consumeQuota('global','paid-search',3,60000),e=>e.status===429);await restored.consumeQuota('other-user','paid-search',3,60000);now+=60000;assert.deepEqual(await restored.consumeQuota('global','paid-search',3,60000),{ok:true});
});
test('AC13 crypto admission is bounded for concurrent password checks, including deletion',async t=>{
 const h=await setup(t);const results=await Promise.allSettled(Array.from({length:140},()=>h.store.deleteAccount('invalid-session',{password:credentials.password})));assert.equal(results.every(r=>r.status==='rejected'),true);assert.ok(results.some(r=>r.reason.status===503));assert.ok(results.some(r=>r.reason.status===401));assert.deepEqual(await h.store.listUsers(),[]);
});
test('AC14 live token capacity is enforced without discarding existing verification records',async t=>{
 const h=await setup(t);await h.store.register(credentials);const data=JSON.parse(await readFile(h.file,'utf8'));data.tokens=Array.from({length:2000},(_,i)=>({hash:i.toString(16).padStart(64,'0'),userId:data.users[0].id,kind:'verify',expiresAt:Date.now()+600000}));await writeFile(h.file,JSON.stringify(data),{mode:0o600});const full=createAccountStore({file:h.file,origin:'https://rolemorrow.example'});await assert.rejects(full.register(credentials),e=>e.status===503);assert.equal(JSON.parse(await readFile(h.file,'utf8')).tokens.length,2000);
});
