'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAccountBoundDownloads}=require('../download-state');
const user={id:'moderator-a',staffRole:'moderator',emailVerified:true};
const endpoint='/api/admin/charts/private-folder/private-chart/download-manifest';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('normal navigation hides private download state until the same account is confirmed',async()=>{
 let read=async()=>user,cancelled=0;const events=[];
 const state=createAccountBoundDownloads({readAccount:()=>read(),cancel:()=>cancelled++,publish:value=>events.push(value)});
 assert.deepEqual(state.snapshot().items,[]);await state.refresh();const token=state.begin([endpoint],'single');
 state.progress(token,{percent:35,folderName:'Private song'});const before=state.snapshot();
 state.invalidate();assert.deepEqual(state.snapshot().items,[]);
 const pending=deferred();read=()=>pending.promise;const checked=state.refresh();
 assert.equal(state.progress(token,{percent:40}),false);assert.deepEqual(events.at(-1).items,[]);
 pending.resolve(user);await checked;assert.equal(cancelled,0);assert.equal(state.current(token),true);
 assert.equal(state.snapshot().items[0].folderName,'Private song');assert.equal(state.snapshot().items[0].percent,40);assert.ok(state.snapshot().revision>before.revision);
});
test('logout, another account and permission loss purge private history and ignore old callbacks',async()=>{
 for(const next of [null,{...user,id:'member-b'},{...user,staffRole:null},{...user,emailVerified:false}]){
  let account=user,cancelled=0;const state=createAccountBoundDownloads({readAccount:async()=>account,cancel:()=>cancelled++});
  await state.refresh();const old=state.begin([endpoint],'single');state.progress(old,{folderName:'Secret',percent:50});
  account=next;state.invalidate();await state.refresh();assert.equal(cancelled,1);assert.deepEqual(state.snapshot().items,[]);
  const current=state.begin(['/public-chart'],'single');state.progress(old,{folderName:'Secret',percent:99});state.finish(old,{ok:true,folderName:'Secret'});
  assert.equal(state.snapshot().items.length,1);assert.equal(state.snapshot().items[0].endpoint,'/public-chart');assert.equal(state.snapshot().operation.active,true);
  assert.equal(JSON.stringify(state.snapshot()).includes('Secret'),false);assert.equal(state.current(current),true);
 }
});
test('unavailable or malformed account checks fail closed and cancel an active download',async()=>{
 for(const failure of [()=>{throw Error('offline');},()=>({}),()=>undefined]){
  let read=async()=>user,cancelled=0;const state=createAccountBoundDownloads({readAccount:()=>read(),cancel:()=>cancelled++});await state.refresh();
  const token=state.begin([endpoint],'single');read=failure;assert.equal((await state.refresh()).ok,false);
  assert.equal(cancelled,1);assert.equal(state.current(token),false);assert.deepEqual(state.snapshot().items,[]);assert.throws(()=>state.begin([endpoint],'single'),/vérifié/);
  read=async()=>user;await state.refresh();assert.deepEqual(state.snapshot().items,[]);
 }
});
test('an old identity response cannot restore history after an account change',async()=>{
 let read=async()=>user;const state=createAccountBoundDownloads({readAccount:()=>read()});await state.refresh();state.begin([endpoint],'single');
 const old=deferred();read=()=>old.promise;const first=state.refresh();state.invalidate();read=async()=>({...user,id:'new-user'});await state.refresh();
 old.resolve(user);await first;assert.equal(state.user().id,'new-user');assert.deepEqual(state.snapshot().items,[]);
});
test('simultaneous account checks use one request and expose only a defensive snapshot',async()=>{
 const pending=deferred();let calls=0;const state=createAccountBoundDownloads({readAccount:()=>{calls++;return pending.promise;}});
 const checks=[state.refresh(),state.refresh()];assert.equal(calls,1);pending.resolve(user);await Promise.all(checks);
 const token=state.begin([endpoint],'single');state.finish(token,{ok:true,folderName:'Original'});const copy=state.snapshot();copy.items[0].folderName='Changed';copy.operation.endpoints.length=0;
 assert.equal(state.snapshot().items[0].folderName,'Original');assert.equal(state.snapshot().operation.endpoints.length,1);
});
