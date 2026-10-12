'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { parseBadSongsReport, relativeTarget, createBadSongsCleanup, verifyNativeBadSongCleanup } = require('../companion/library-bad-songs.cjs');
const ERROR = 'ERROR: These folders have corrupt (or broken) notes.mid or notes.chart files!';
const META = 'ERROR: These folders either have no valid metadata file (song.ini), or the metadata does not include a valid song name!';
const report = paths => ERROR + '\n' + paths.join('\n') + '\n';
async function fixture(t, folders = ['A','B']) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-bad-songs-')), root = path.join(base,'Songs'), bin = path.join(base,'fake-bin'), filename = path.join(base,'badsongs.txt');
  await fs.mkdir(root); await fs.mkdir(bin);
  for (const folder of folders) { await fs.mkdir(path.join(root,folder)); await fs.writeFile(path.join(root,folder,'notes.mid'), 'corrupt raw MIDI bytes'); await fs.writeFile(path.join(root,folder,'song.ini'),'[song]\nname=Broken song\n'); }
  await fs.writeFile(filename,report(folders.map(folder => path.join(root,folder))));
  let document = { settings: { rootPath: root }, revision: 7, items: [] }; const recycled = [], events = [];
  const cleanup = createBadSongsCleanup({ getDocument: () => document,
    recycle: async (target, proof) => { await verifyNativeBadSongCleanup({ root, target, proof }); recycled.push(target); await fs.rename(target,path.join(bin,path.basename(target))); },
    onCleaned: async event => { events.push(event); document = { ...document, revision: document.revision + 1, items: [...document.items] }; }
  });
  t.after(async () => { await cleanup.stop(); assert.equal(path.dirname(base), await fs.realpath(os.tmpdir())); assert.match(path.basename(base), /^chartshub-bad-songs-/); await fs.rm(base,{recursive:true,force:true}); });
  return { base,root,bin,filename,cleanup,recycled,events,getDocument: () => document,setDocument: value => { document=value; }, request: plan => ({planId:plan.planId,revision:plan.revision,ids:plan.entries.filter(entry => entry.eligible).map(entry=>entry.id)}) };
}
test('real Clone Hero headers distinguish fatal errors, warnings and unknown formats', () => {
  const text = "Warning: These folders contain video backgrounds that wont work on all game platforms, which may be deprecated in the future.\nThis warning is primarily aimed at charters.\nF:\\Songs\\A\n\n" + META + '\nF:\\Songs\\B\n\n' + ERROR + '\nF:\\Songs\\A\n\nERROR: Future unknown format\nF:\\Songs\\C\n';
  const parsed = parseBadSongsReport(text,path.win32);
  assert.deepEqual(parsed.entries.map(entry=>[entry.severity,entry.recognized]),[['warning',false],['error',true],['error',true],['error',false]]);
  assert.equal(parsed.entries[0].reportedPath,'F:\\Songs\\A'); assert.equal(parsed.entries[1].reasons[0],META);
  assert.throws(()=>parseBadSongsReport('not a Clone Hero report')); assert.throws(()=>parseBadSongsReport(ERROR+'\0\nF:\\Songs\\A'));
});
test('duplicate path lines aggregate exact reasons without selecting a target twice', () => {
  const parsed=parseBadSongsReport(ERROR+'\nC:\\Songs\\A\nC:\\Songs\\A\n'+META+'\nC:\\Songs\\A\n',path.win32);
  assert.equal(parsed.entries.length,1); assert.equal(parsed.entries[0].reasons.length,2);
});
test('root, siblings, relative paths and traversal outside Songs never map to deletion targets', t=>{
  const root=path.resolve(os.tmpdir(),'Songs');
  for (const candidate of [root,path.join(root,'..','other'),path.resolve(root+'-other','A'),'A','../A']) assert.equal(relativeTarget(root,candidate),null);
  assert.equal(relativeTarget(root,path.join(root,'nested','A')),'nested/A');
});
test('warnings, out-of-root paths and unknown error categories are visible but never eligible', async t=>{
  const f=await fixture(t); await fs.writeFile(f.filename,'Warning: Unsupported video format\n'+path.join(f.root,'A')+'\n'+ERROR+'\n'+f.root+'\n'+f.base+'\nERROR: Future unknown format\n'+path.join(f.root,'B')+'\n');
  const plan=await f.cleanup.prepare(f.filename);
  assert.equal(plan.entries.length,4); assert.ok(plan.entries.every(entry=>!entry.eligible));
  for (const entry of plan.entries) await assert.rejects(f.cleanup.execute({planId:plan.planId,revision:plan.revision,ids:[entry.id]}));
  assert.deepEqual(f.recycled,[]);
});
test('raw corrupt notes and absent audio can be reviewed; no item is recycled on import or review', async t=>{
  const f=await fixture(t), plan=await f.cleanup.prepare(f.filename);
  assert.equal(plan.entries.length,2); assert.ok(plan.entries.every(entry=>entry.eligible && entry.bytes>0));
  const request=f.request(plan); assert.equal((await f.cleanup.review(request)).entries.length,2);
  assert.deepEqual(f.recycled,[]); assert.equal(await fs.readFile(path.join(f.root,'A','notes.mid'),'utf8'),'corrupt raw MIDI bytes');
  await assert.rejects(f.cleanup.execute({...request,ids:[]})); await assert.rejects(f.cleanup.execute({...request,rootPath:f.root}));
});
test('only selected charts reach the fake bin and remaining charts can be cleaned without rescanning', async t=>{
  const f=await fixture(t), plan=await f.cleanup.prepare(f.filename), first=plan.entries[0];
  const result=await f.cleanup.execute({planId:plan.planId,revision:plan.revision,ids:[first.id]});
  assert.deepEqual(result.recycledIds,[first.id]); assert.equal(result.plan.entries.length,1); assert.equal(f.events.length,1);
  assert.equal(f.recycled.length,1); assert.ok(await fs.stat(path.join(f.root,'B')));
  assert.equal(result.plan.revision,8); assert.notEqual(result.plan.planId,plan.planId);
  const second=await f.cleanup.execute(f.request(result.plan)); assert.equal(second.recycledIds.length,1); assert.equal(f.events.length,2);
});
test('a file changed while native confirmation is open blocks that item and stops the batch', async t=>{
  const f=await fixture(t), plan=await f.cleanup.prepare(f.filename), request=f.request(plan);
  await f.cleanup.review(request); await fs.writeFile(path.join(f.root,'A','notes.mid'),'changed corrupt notes');
  const result=await f.cleanup.execute(request); assert.equal(result.failed.length,1); assert.deepEqual(result.recycledIds,[]); assert.deepEqual(f.recycled,[]);
});
test('changed report or root revision invalidates the reviewed plan', async t=>{
  const f=await fixture(t), plan=await f.cleanup.prepare(f.filename);
  await fs.appendFile(f.filename,'\n'); await assert.rejects(f.cleanup.review(f.request(plan)));
  const next=await f.cleanup.prepare(f.filename); f.setDocument({...f.getDocument(),revision:99}); await assert.rejects(f.cleanup.execute(f.request(next)));
  assert.deepEqual(f.recycled,[]);
});
test('nested folders, shared indexed targets and extra chart files are protected', async t=>{
  const f=await fixture(t,['Nested','Shared','TwoNotes']);
  await fs.mkdir(path.join(f.root,'Nested','child')); await fs.writeFile(path.join(f.root,'TwoNotes','notes.chart'),'other version');
  f.setDocument({...f.getDocument(),items:[{id:'1',relativePath:'Shared/notes.mid'},{id:'2',relativePath:'Shared/notes.chart'}]});
  const plan=await f.cleanup.prepare(f.filename); assert.ok(plan.entries.every(entry=>!entry.eligible)); assert.deepEqual(f.recycled,[]);
});
test('changed identities between the worker and native boundary never reach the native bin', async t=>{
  const f=await fixture(t);
  const proof=[]; const state=f.getDocument();
  const cleanup=createBadSongsCleanup({getDocument:()=>state,recycle:async(target,value)=>{proof.push({target,value});}});
  const ready=await cleanup.prepare(f.filename); await cleanup.execute({planId:ready.planId,revision:ready.revision,ids:[ready.entries[1].id]});
  await fs.writeFile(path.join(f.root,'B','notes.mid'),'changed after IPC'); await assert.rejects(verifyNativeBadSongCleanup({root:f.root,target:proof[0].target,proof:proof[0].value}));
  await cleanup.stop();
});
test('shared folder/container report targets are both blocked independent of report order', async t=>{
  const f=await fixture(t,['Container']); await fs.unlink(path.join(f.root,'Container','notes.mid')); await fs.writeFile(path.join(f.root,'Container','song.sng'),'bad container');
  for (const targets of [[path.join(f.root,'Container'),path.join(f.root,'Container','song.sng')],[path.join(f.root,'Container','song.sng'),path.join(f.root,'Container')]]) {
    await fs.writeFile(f.filename,report(targets)); const plan=await f.cleanup.prepare(f.filename); assert.equal(plan.entries.length,2); assert.ok(plan.entries.every(entry=>!entry.eligible && entry.blocked==='shared'));
  }
});
test('ChartsHub data directory is protected when inside, equal to or above Songs', async t=>{
  const f=await fixture(t); const document=f.getDocument();
  for (const protectedDirectory of [f.base,f.root,path.join(f.root,'A'),path.join(f.root,'A','profile')]) {
    const cleanup=createBadSongsCleanup({getDocument:()=>document,protectedDirectory,recycle:async()=>{throw Error('Unexpected recycle');}});
    const plan=await cleanup.prepare(f.filename); assert.equal(plan.entries[0].eligible,false); assert.equal(plan.entries[0].blocked,'protected'); await cleanup.stop();
  }
});
test('the shared filesystem guards reject reported hardlinks and symlink identities', async t=>{
  const Module=require('node:module'), raw=require('node:fs').readFileSync(require.resolve('../companion/chart-bundle.cjs'),'utf8');
  const f=await fixture(t), filename=path.join(f.root,'A','notes.mid');
  for (const attack of ['hardlink','symlink']) {
    const local=new Module(require.resolve('../companion/chart-bundle.cjs'),module); local.filename=require.resolve('../companion/chart-bundle.cjs'); local.paths=module.paths;
    const original=local.require.bind(local); local.require=name=>name==='node:fs/promises' ? {...fs,lstat:async(target,options)=>{
      const stat=await fs.lstat(target,options); if(path.relative(filename,target)!=='')return stat;
      return new Proxy(stat,{get:(value,key)=>key==='nlink'&&attack==='hardlink'?(options?.bigint?2n:2):key==='isSymbolicLink'&&attack==='symlink'?()=>true:typeof value[key]==='function'?value[key].bind(value):value[key]});
    }}:original(name); local._compile(raw,local.filename);
    assert.equal(await local.exports.inspectReportedBundle({rootPath:f.root,targetRelativePath:'A'}),null);
    assert.ok(await local.exports.inspectReportedBundle({rootPath:f.root,targetRelativePath:'B'}));
  }
});
test('the native boundary requires the complete prior hash and identity proof',async t=>{
  const f=await fixture(t),proof={type:'bad-songs',rootPath:f.root,targetRelativePath:'A',kind:'folder'};
  for (const expected of [undefined,null,{}, {digest:'a'.repeat(64),kind:'folder',targetRelativePath:'A',bytes:0}, {identity:{},digest:'x',bytes:0,kind:'folder',targetRelativePath:'A'}]) {
    await assert.rejects(verifyNativeBadSongCleanup({root:f.root,target:path.join(f.root,'A'),proof:{...proof,expected}}),{code:'LIBRARY_BAD_SONGS_SAFE'});
  }
  assert.deepEqual(f.recycled,[]);
});
