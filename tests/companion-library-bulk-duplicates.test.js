'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createInstalledLibraryService}=require('../companion/library-service.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function settled(service){
  const started=Date.now();
  while(service.status().status==='scanning'){
    if(Date.now()-started>10000)throw Error('scan timeout');
    await delay(10);
  }
  await delay(0);
}
async function fixture(t,groups=1){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-bulk-duplicates-'));
  const root=path.join(base,'Songs'),dataDirectory=path.join(base,'profile');
  await fs.mkdir(root);await fs.mkdir(dataDirectory);
  for(let i=0;i<groups;i++){
    const title='Song '+String(i).padStart(2,'0');
    for(const suffix of ['A','B']){
      const folder=path.join(root,'G'+String(i).padStart(2,'0')+'-'+suffix);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder,'notes.chart'),'[Song]\n{\n Name = "'+title+'"\n Artist = "Artist"\n Charter = "Charter"\n}\n');
      await fs.writeFile(path.join(folder,'song.ini'),'[song]\nname='+title+'\nartist=Artist\ncharter=Charter\n');
      await fs.writeFile(path.join(folder,'song.ogg'),'audio-'+i);
    }
  }
  const recycled=[],updates=[];
  const service=createInstalledLibraryService({dataDirectory,recycle:async target=>{recycled.push(target);},onChange:value=>updates.push(value)});
  t.after(async()=>{await service.stop();await fs.rm(base,{recursive:true,force:true});});
  await service.selectRoot(root);await settled(service);
  assert.equal(service.status().count,groups*2);
  return {service,root,recycled,updates};
}
async function chooseKeeperForEveryGroup(service){
  const revision=service.status().revision;
  const page=service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:0,limit:100});
  const seen=new Set();
  for(const item of page.items){
    if(seen.has(item.title))continue;
    seen.add(item.title);
    const comparison=await service.compareDuplicates({id:item.id,revision});
    await service.chooseDuplicate({contextId:comparison.contextId,revision:comparison.revision,id:item.id});
  }
  return page.items;
}

test('global duplicate verification covers every group beyond the first 50 visible rows',async t=>{
  const f=await fixture(t,26);
  await chooseKeeperForEveryGroup(f.service);
  const result=await f.service.verifyAllDuplicates();
  assert.deepEqual(result,{revision:f.service.status().revision,totalGroups:26,readyGroups:26,needsKeeperGroups:0,blockedGroups:0,eligibleCopies:26});
  assert.equal(f.recycled.length,0,'verification must never recycle files');
  const first=f.service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:0,limit:50});
  const last=f.service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:50,limit:50});
  assert.equal(first.items.length,50);assert.equal(last.items.length,2);
  assert.ok([...first.items,...last.items].every(item=>item.duplicateVerification==='ready'&&item.verifiedEligibleCopies===1));
  assert.ok(f.updates.some(update=>update.duplicateVerification?.total===26&&update.duplicateVerification.processed>0));
  assert.ok(f.updates.some(update=>update.duplicateVerification?.processed===26));
});

test('global duplicate verification marks groups that still need a keeper without deleting anything',async t=>{
  const f=await fixture(t,1);
  const result=await f.service.verifyAllDuplicates();
  assert.equal(result.totalGroups,1);assert.equal(result.needsKeeperGroups,1);assert.equal(result.readyGroups,0);assert.equal(result.blockedGroups,0);
  const page=f.service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:0,limit:50});
  assert.ok(page.items.every(item=>item.duplicateVerification==='needs_keeper'));
  assert.equal(f.recycled.length,0);
});

test('global duplicate verification blocks a group when keeper audio changed after the saved choice',async t=>{
  const f=await fixture(t,1);
  const items=await chooseKeeperForEveryGroup(f.service);
  const keeper=items[0];
  await fs.writeFile(path.join(f.root,path.dirname(keeper.relativePath),'song.ogg'),'changed keeper audio');
  const result=await f.service.verifyAllDuplicates();
  assert.equal(result.totalGroups,1);assert.equal(result.readyGroups,0);assert.equal(result.blockedGroups,1);assert.equal(result.eligibleCopies,0);
  const page=f.service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:0,limit:50});
  assert.ok(page.items.every(item=>item.duplicateVerification==='blocked'));
  assert.equal(f.recycled.length,0);
});
