'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createInstalledLibraryService}=require('../companion/library-service.cjs');
const ERROR='ERROR: These folders have corrupt (or broken) notes.mid or notes.chart files!';
async function fixture(t,recycle){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-bad-integration-')),root=path.join(base,'Songs'),dataDirectory=path.join(base,'Profile'),filename=path.join(base,'badsongs.txt'),bin=path.join(base,'FakeBin');
  await fs.mkdir(root);await fs.mkdir(dataDirectory);await fs.mkdir(bin);
  for(const folder of ['A','B']){await fs.mkdir(path.join(root,folder));await fs.writeFile(path.join(root,folder,'notes.chart'),'[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}');await fs.writeFile(path.join(root,folder,'song.ini'),'[song]\nname=Example\nartist=Band\ncharter=Creator\n');}
  const targets=['A','B'].map(folder=>path.join(root,folder));await fs.writeFile(filename,ERROR+'\n'+targets.join('\n')+'\n');
  const recycled=[],service=createInstalledLibraryService({dataDirectory,recycle:async(target,proof)=>{recycled.push(target);if(recycle)await recycle({target,proof,service,root,base});else await fs.rename(target,path.join(bin,path.basename(target)));}});
  t.after(async()=>{await service.stop();assert.equal(path.dirname(base),await fs.realpath(os.tmpdir()));assert.match(path.basename(base),/^chartshub-bad-integration-/);await fs.rm(base,{recursive:true,force:true});});
  await service.selectRoot(root);for(let attempt=0;attempt<300&&service.status().status==='scanning';attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(service.status().status,'ready');
  return{base,root,filename,service,recycled};
}
test('reported cleanup removes selected index rows, continues through remaining charts and runs a single final scan',async t=>{
  const f=await fixture(t);assert.equal(f.service.status().count,2);const scan=f.service.status().lastScanAt,plan=await f.service.prepareBadSongs(f.filename);
  const target=plan.entries[0],result=await f.service.recycleBadSongs({planId:plan.planId,revision:plan.revision,ids:[target.id]});
  assert.equal(result.recycledIds.length,1);assert.equal(f.service.status().count,1);assert.equal(f.service.status().cleanupRefreshPending,true);assert.equal(f.service.status().lastScanAt,scan);
  const remaining=result.plan;await f.service.recycleBadSongs({planId:remaining.planId,revision:remaining.revision,ids:[remaining.entries[0].id]});assert.equal(f.service.status().count,0);assert.equal(f.service.status().lastScanAt,scan);
  await f.service.requestScan('quick');for(let attempt=0;attempt<300&&f.service.status().status==='scanning';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.service.status().cleanupRefreshPending,false);assert.equal(f.service.status().status,'ready');assert.notEqual(f.service.status().lastScanAt,scan);
});
test('report casing follows Windows mapping and immediately removes the matching indexed row',async t=>{
  const f=await fixture(t),reported=path.join(f.root,'A');await fs.writeFile(f.filename,ERROR+'\n'+(process.platform==='win32'?reported.toLowerCase():reported)+'\n');
  const plan=await f.service.prepareBadSongs(f.filename),before=f.service.status().count;
  const result=await f.service.recycleBadSongs({planId:plan.planId,revision:plan.revision,ids:[plan.entries[0].id]});assert.equal(result.recycledIds.length,1);assert.equal(f.service.status().count,before-1);assert.ok((await f.service.query()).items.every(item=>!item.relativePath.startsWith('A/')));
});
test('native recycling locks scan, root mutation and duplicate preparation until the batch ends',async t=>{
  const f=await fixture(t,async({service,root,target,base})=>{
    assert.throws(()=>service.requestScan('quick'),{code:'LIBRARY_CLEANUP_SAFE'});await assert.rejects(service.selectRoot(root),{code:'LIBRARY_CLEANUP_SAFE'});await assert.rejects(service.configure({watch:true}),{code:'LIBRARY_CLEANUP_SAFE'});await assert.rejects(service.prepareBulkCleanup(),{code:'LIBRARY_CLEANUP_SAFE'});
    await fs.rename(target,path.join(base,'FakeBin',path.basename(target)));
  });const plan=await f.service.prepareBadSongs(f.filename);const result=await f.service.recycleBadSongs({planId:plan.planId,revision:plan.revision,ids:plan.entries.map(entry=>entry.id)});assert.equal(result.failed.length,0);assert.equal(result.recycledIds.length,2);
});
