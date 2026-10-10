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
  return {service,root,dataDirectory,recycled,updates};
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
  assert.deepEqual(result,{revision:f.service.status().revision,totalGroups:26,processedGroups:26,cancelled:false,readyGroups:26,needsKeeperGroups:0,blockedGroups:0,eligibleCopies:26});
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

async function directoryContents(directory){
  const result={};
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const filename=path.join(directory,entry.name);
    result[entry.name]=entry.isDirectory()?await directoryContents(filename):(await fs.readFile(filename)).toString('base64');
  }
  return result;
}

for(const [phase,readNumber] of [['comparison',1],['cleanup preparation',2]]){
  test('stopping global verification during '+phase+' aborts current hashing, preserves completed groups and permits restart',async t=>{
    const f=await fixture(t,3);
    await chooseKeeperForEveryGroup(f.service);
    const originalSongs=await directoryContents(f.root),originalProfile=await directoryContents(f.dataDirectory);
    const target=path.join(f.root,'G01-A','song.ogg');
    const open=fs.open;
    let readCount=0,cancelled,repeated;
    const opened=[];
    const mock=t.mock.method(fs,'open',async(...args)=>{
      const handle=await open(...args);
      opened.push(String(args[0]));
      if(args[0]===target){
        const read=handle.read.bind(handle);
        handle.read=async(...readArgs)=>{
          if(++readCount===readNumber){
            cancelled=f.service.cancelDuplicateVerification();
            repeated=f.service.cancelDuplicateVerification();
            assert.equal(f.service.status().duplicateVerification.stopping,true);
          }
          return read(...readArgs);
        };
      }
      return handle;
    });
    const result=await f.service.verifyAllDuplicates();
    assert.ok(cancelled,'the active audio hashing phase was reached');
    assert.deepEqual(await cancelled,result);assert.deepEqual(await repeated,result);
    assert.deepEqual(result,{revision:f.service.status().revision,totalGroups:3,processedGroups:1,cancelled:true,readyGroups:1,needsKeeperGroups:0,blockedGroups:0,eligibleCopies:1});
    assert.equal(f.service.status().duplicateVerification,null);
    assert.equal(f.service.status().status,'ready');
    assert.ok(!opened.some(filename=>filename.includes('G02-')),'unstarted groups must not be read after cancellation');
    const page=f.service.query({query:'',sort:'title',audio:'all',duplicates:'possible',offset:0,limit:50});
    assert.ok(page.items.filter(item=>item.title==='Song 00').every(item=>item.duplicateVerification==='ready'));
    assert.ok(page.items.filter(item=>item.title!=='Song 00').every(item=>item.duplicateVerification===undefined),'an interrupted group must not be marked ready or blocked');
    assert.equal(f.recycled.length,0);
    mock.mock.restore();
    assert.deepEqual(await directoryContents(f.root),originalSongs,'all songs are unchanged');
    assert.deepEqual(await directoryContents(f.dataDirectory),originalProfile,'index and keeper preferences are unchanged');
    assert.equal(await f.service.cancelDuplicateVerification(),null,'an idle stop is harmless');
    const restarted=await f.service.verifyAllDuplicates();
    assert.equal(restarted.cancelled,false);assert.equal(restarted.processedGroups,3);assert.equal(restarted.readyGroups,3);
    assert.deepEqual(await directoryContents(f.root),originalSongs);
    assert.deepEqual(await directoryContents(f.dataDirectory),originalProfile);
  });
}

test('stopping without global verification leaves a prepared cleanup untouched',async t=>{
  const f=await fixture(t);
  const items=await chooseKeeperForEveryGroup(f.service);
  const revision=f.service.status().revision;
  const comparison=await f.service.compareDuplicates({id:items[0].id,revision});
  const plan=await f.service.prepareCleanup({contextId:comparison.contextId,revision,keepId:comparison.preferredId});
  assert.equal(await f.service.cancelDuplicateVerification(),null);
  const review=await f.service.cleanupReview({planId:plan.planId,revision,ids:[plan.candidates[0].id]});
  assert.equal(review.keep.id,plan.keepId);assert.equal(f.recycled.length,0);
});
