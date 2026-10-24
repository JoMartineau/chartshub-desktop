'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createUpdateService}=require('../desktop/update-service.cjs');
const {fixture}=require('./update-fixture.cjs');
async function temporary(t){const root=await fs.mkdtemp(path.join(process.env.CHARTSHUB_UPDATE_TEST_ROOT||os.tmpdir(),'chartshub-update-fixture-'));const actual=await fs.realpath(root);t.after(async()=>{if(!path.basename(actual).startsWith('chartshub-update-fixture-')||!path.isAbsolute(actual))throw Error('Unsafe fixture cleanup');await fs.rm(actual,{recursive:true,force:true});});return actual;}
test('no network or install occurs on construction, check is explicit and verified download is exact',async t=>{
 const root=await temporary(t),f=fixture(),states=[];let plans=0;
 const updater=createUpdateService({currentVersion:'0.14.26',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,applicationDirectory:path.join(root,'app'),fetcher:f.fetcher,onChange:x=>states.push(x),makePlan:async()=>{plans++;throw Error('Never reached');}});
 assert.equal(f.requests.length,0);assert.equal(updater.snapshot().canInstall,false);
 await updater.check();assert.equal(updater.snapshot().status,'available');await updater.download();const state=updater.snapshot();assert.equal(state.status,'ready');assert.equal(state.canInstall,true);assert.equal(plans,0);assert(!JSON.stringify(state).includes(root));
 const cache=path.join(root,'updates'),folders=await fs.readdir(cache);assert.equal(folders.length,1);assert.deepEqual(await fs.readFile(path.join(cache,folders[0],'ChartsHub-win32-x64.zip')),f.bytes.get('ChartsHub-win32-x64.zip'));assert(states.some(x=>x.status==='downloading'));
});
test('same or newer installed version prevents download and downgrade',async()=>{
 for(const version of ['0.14.99','1.0.0']){const f=fixture(),updater=createUpdateService({currentVersion:version,fetcher:f.fetcher});await updater.check();assert.equal(updater.snapshot().status,'current');assert.equal(updater.snapshot().canDownload,false);await assert.rejects(()=>updater.download(),{code:'UPDATE_NO_UPDATE'});}
});
test('unsupported OS opens the official release and never claims installation',async()=>{
 const f=fixture(),opened=[];const updater=createUpdateService({currentVersion:'0.14.26',platform:'darwin',arch:'arm64',packaged:true,fetcher:f.fetcher,openExternal:async url=>opened.push(url)});await updater.check();await updater.download();assert.deepEqual(opened,[f.metadata.html_url]);assert.equal(updater.snapshot().installSupported,false);assert.equal(updater.snapshot().status,'available');await assert.rejects(()=>updater.stageInstallation(),{code:'UPDATE_INSTALL_UNSUPPORTED'});
});
test('corrupted archive and manifest are refused before an install can be prepared',async t=>{
 for(const name of ['ChartsHub-win32-x64.zip','SHA256SUMS.txt']){const root=await temporary(t),f=fixture();f.bytes.set(name,Buffer.from('invalid'));
  const updater=createUpdateService({currentVersion:'0.14.26',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,fetcher:f.fetcher});await updater.check();await assert.rejects(()=>updater.download());assert.equal(updater.snapshot().canInstall,false);assert.equal(updater.snapshot().status,'error');}
});
test('incompatible operation blocks install and does not silently stop user operations',async t=>{
 const root=await temporary(t),f=fixture();let busy=[];let plans=0;
 const updater=createUpdateService({currentVersion:'0.14.26',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,fetcher:f.fetcher,busyReasons:()=>busy,makePlan:async()=>{plans++;}});await updater.check();await updater.download();busy=['chart_downloads','library_scanning'];assert.equal(updater.snapshot().canInstall,false);await assert.rejects(()=>updater.stageInstallation(),{code:'UPDATE_OPERATIONS_ACTIVE'});assert.equal(plans,0);assert.deepEqual(busy,['chart_downloads','library_scanning']);
});
test('shutdown authorization is a distinct explicit step after helper readiness',async t=>{
 const root=await temporary(t),f=fixture();let created,launched=0;
 const makePlan=async()=>{const directory=path.join(root,'plan');await fs.mkdir(directory);const planPath=path.join(directory,'plan.json');await fs.writeFile(planPath,'{}');created={planPath,planSha256:require('node:crypto').createHash('sha256').update('{}').digest('hex'),authorizationPath:path.join(directory,'authorized.json'),cancelPath:path.join(directory,'cancelled.json')};return created;};
 const updater=createUpdateService({currentVersion:'0.14.26',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,fetcher:f.fetcher,makePlan,launchHelper:async()=>{launched++;}});await updater.check();await updater.download();await updater.stageInstallation();assert.equal(launched,1);await assert.rejects(()=>fs.stat(created.authorizationPath),{code:'ENOENT'});await updater.authorizeInstallation();assert.equal(JSON.parse(await fs.readFile(created.authorizationPath,'utf8')).planSha256,created.planSha256);
});
test('changed plan cannot receive shutdown authorization; cancelled helper gets no apply permission',async t=>{
 const root=await temporary(t),f=fixture();let job;
 const updater=createUpdateService({currentVersion:'0.14.26',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,fetcher:f.fetcher,makePlan:async()=>{const planPath=path.join(root,'plan.json');await fs.writeFile(planPath,'{}');job={planPath,planSha256:'a'.repeat(64),authorizationPath:path.join(root,'authorized.json'),cancelPath:path.join(root,'cancelled.json')};return job;},launchHelper:async()=>{}});await updater.check();await updater.download();await updater.stageInstallation();await assert.rejects(()=>updater.authorizeInstallation(),{code:'UPDATE_PLAN_CHANGED'});await updater.cancelInstallation();assert.equal(await fs.readFile(job.cancelPath,'utf8'),'{}\n');await assert.rejects(()=>fs.stat(job.authorizationPath),{code:'ENOENT'});
});
test('startup exposes a bounded public outcome without replaying a helper or leaking receipt paths',async t=>{
 const root=await temporary(t),directory=path.join(root,'updates','install-12345678-1234-4234-8234-123456789abc');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({status:'rolled-back',version:'0.14.99',error:'private fixture path C:/Private'}));
 const f=fixture(),updater=createUpdateService({currentVersion:'0.14.27',dataDirectory:root,fetcher:f.fetcher});await updater.loadPreviousResult();assert.deepEqual(updater.snapshot().lastResult,{status:'rolled-back',version:'0.14.99'});assert(!JSON.stringify(updater.snapshot()).includes('Private'));assert.equal(f.requests.length,0);
});
