'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const rollback=require('../desktop/update-rollback.cjs'),planApi=require('../desktop/update-plan.cjs'),{createUpdateService}=require('../desktop/update-service.cjs');
function asar(version){const pkg=Buffer.from(JSON.stringify({name:'chartshub-desktop',version})),json=Buffer.from(JSON.stringify({files:{'package.json':{size:pkg.length,offset:'0'}}})),payload=Math.ceil((json.length+4)/4)*4,prefix=Buffer.alloc(16);prefix.writeUInt32LE(4);prefix.writeUInt32LE(payload+4,4);prefix.writeUInt32LE(payload,8);prefix.writeUInt32LE(json.length,12);return Buffer.concat([prefix,json,Buffer.alloc(payload-4-json.length),pkg]);}
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(process.env.CHARTSHUB_UPDATE_TEST_ROOT||os.tmpdir(),'chartshub-rollback-fixture-')));t.after(async()=>{assert(path.isAbsolute(root)&&path.basename(root).startsWith('chartshub-rollback-fixture-'));await fs.rm(root,{recursive:true,force:true});});
 const app=path.join(root,'ChartsHub-win32-x64'),data=path.join(root,'profile'),cache=path.join(data,'updates'),id=crypto.randomUUID(),job=path.join(cache,'install-'+id),backup=app+'.backup-'+id;
 for(const [directory,version]of [[app,'0.14.28'],[backup,'0.14.27']]){await fs.mkdir(path.join(directory,'resources'),{recursive:true});await fs.writeFile(path.join(directory,'ChartsHub.exe'),'synthetic executable '+version);await fs.writeFile(path.join(directory,'resources/app.asar'),asar(version));}
 await fs.mkdir(job,{recursive:true});const helperBytes=await fs.readFile(path.join(__dirname,'../desktop/update-install.ps1'));await fs.writeFile(path.join(job,'update-install.ps1'),helperBytes);
 const prior=await planApi.treeManifest(backup),installed=await planApi.treeManifest(app),plan={schema:2,kind:'update',id,applicationDirectory:app,dataDirectory:data,cacheDirectory:cache,jobDirectory:job,currentVersion:'0.14.27',version:'0.14.28',pid:424242,prior,helperSha256:planApi.hash(helperBytes),createdAt:new Date().toISOString(),archivePath:path.join(cache,'ChartsHub-win32-x64.zip'),archiveSha256:'c'.repeat(64),archiveBytes:12,commit:'a'.repeat(40),tree:'b'.repeat(40),releaseId:901};
 const bytes=Buffer.from(JSON.stringify(plan)+'\n'),planSHA=planApi.hash(bytes);await fs.writeFile(path.join(job,'plan.json'),bytes);for(const file of ['ready.json','authorized.json'])await fs.writeFile(path.join(job,file),JSON.stringify({planSha256:planSHA}));
 await fs.writeFile(path.join(job,'result.json'),JSON.stringify({format:'chartshub-update-result',schema:2,jobId:id,kind:'update',status:'complete',version:'0.14.28',previousVersion:'0.14.27',planSha256:planSHA,application:app,backup,previousManifest:prior,installedManifest:installed}));
 return {root,app,data,cache,job,backup,prior,installed,options:{applicationDirectory:app,dataDirectory:data,currentVersion:'0.14.28'}};
}
test('only a completed updater transaction with ready and shutdown proofs offers a verified previous version',async t=>{
 const f=await fixture(t),candidate=await rollback.findRollback(f.options);assert.equal(candidate.version,'0.14.27');assert.equal(candidate.backup,f.backup);assert(rollback.equalManifest(candidate.currentManifest,f.installed));assert(rollback.equalManifest(candidate.sourceManifest,f.prior));
});
test('legacy or arbitrary sibling backups never enable a manual return',async t=>{
 const f=await fixture(t);await fs.unlink(path.join(f.job,'authorized.json'));assert.equal(await rollback.findRollback(f.options),null);await fs.mkdir(path.join(f.root,'ChartsHub-win32-x64.backup-Codex'));assert.equal(await rollback.findRollback(f.options),null);
});
test('source plan, receipt and copied helper mutations invalidate rollback provenance',async t=>{
 for(const file of ['plan.json','result.json','update-install.ps1']){const f=await fixture(t);if(file==='result.json'){const value=JSON.parse(await fs.readFile(path.join(f.job,file),'utf8'));value.status='failed';await fs.writeFile(path.join(f.job,file),JSON.stringify(value));}else await fs.appendFile(path.join(f.job,file),' ');assert.equal(await rollback.findRollback(f.options),null);}
});
test('current app and previous backup edits are preserved and prevent rollback',async t=>{
 for(const key of ['app','backup']){const f=await fixture(t);await fs.writeFile(path.join(f[key],'external.txt'),'external fixture');assert.equal(await rollback.findRollback(f.options),null);assert.equal(await fs.readFile(path.join(f[key],'external.txt'),'utf8'),'external fixture');}
});
test('rollback preparation revalidates both trees and creates an unauthorised separate helper plan',async t=>{
 const f=await fixture(t),candidate=await rollback.findRollback(f.options),job=await rollback.createRollbackPlan({...f.options,candidate,pid:424242});assert.equal(job.plan.kind,'rollback');assert.equal(job.plan.schema,2);assert.equal(job.plan.version,'0.14.27');assert.equal(job.plan.currentVersion,'0.14.28');assert.equal(job.plan.sourceBackup,f.backup);assert(rollback.equalManifest(job.plan.prior,f.installed));await assert.rejects(()=>fs.stat(job.authorizationPath),{code:'ENOENT'});
});
test('a once-verified candidate cannot be reused after receipt mutation',async t=>{
 const f=await fixture(t),candidate=await rollback.findRollback(f.options);await fs.appendFile(path.join(f.job,'result.json'),' ');await assert.rejects(()=>rollback.createRollbackPlan({...f.options,candidate,pid:424242}),{code:'UPDATE_BACKUP_CHANGED'});
});
test('service gates manual return on actual busy operations and never contacts the network',async t=>{
 const f=await fixture(t);let busy=[],launches=0;const service=createUpdateService({currentVersion:'0.14.28',platform:'win32',arch:'x64',packaged:true,applicationDirectory:f.app,dataDirectory:f.data,fetcher:async()=>{throw Error('Network must remain unused');},busyReasons:()=>busy,launchHelper:async()=>{launches++;}});
 await service.loadPreviousResult();assert.equal(service.snapshot().canRollback,true);assert.equal(service.snapshot().previousVersion,'0.14.27');busy=['chart_downloads'];assert.equal(service.snapshot().canRollback,false);await assert.rejects(()=>service.stageRollback(),{code:'UPDATE_OPERATIONS_ACTIVE'});assert.equal(launches,0);busy=[];await service.stageRollback();assert.equal(launches,1);assert.equal(service.snapshot().canRollback,false);const jobs=await fs.readdir(f.cache);const latest=jobs.filter(n=>n.startsWith('install-')&&n!==path.basename(f.job))[0];await assert.rejects(()=>fs.stat(path.join(f.cache,latest,'authorized.json')),{code:'ENOENT'});await service.cancelInstallation();assert.equal(service.snapshot().canRollback,true);assert.equal(service.snapshot().canInstall,false);
});
