'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createUpdateService}=require('../desktop/update-service.cjs'),cache=require('../desktop/update-cache.cjs'),releaseApi=require('../desktop/update-release.cjs');
const {fixture}=require('./update-fixture.cjs');
async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(process.env.CHARTSHUB_UPDATE_TEST_ROOT||os.tmpdir(),'chartshub-update-cache-')));t.after(async()=>{if(!path.basename(root).startsWith('chartshub-update-cache-'))throw Error('Unsafe cleanup');await fs.rm(root,{recursive:true,force:true});});return root;}
function service(root,f,extra={}){return createUpdateService({currentVersion:'0.14.29',platform:'win32',arch:'x64',packaged:true,dataDirectory:root,fetcher:f.fetcher,...extra});}
async function completed(t){const root=await temporary(t),f=fixture(),updater=service(root,f);await updater.check();await updater.download();updater.dispose();const directory=path.join(root,'updates',(await fs.readdir(path.join(root,'updates')))[0]);return {root,f,directory,receipt:path.join(directory,cache.RECEIPT),archive:path.join(directory,'ChartsHub-win32-x64.zip')};}
test('completed update survives restart without a network request, installation or private paths in its snapshot',async t=>{
 const {root,f}=await completed(t),before=f.requests.length;let installed=0;
 const next=service(root,f,{makePlan:async()=>{installed++;throw Error('Not authorized');}});await next.loadPreviousResult();
 assert.equal(next.snapshot().status,'cached');assert.equal(next.snapshot().cachedVersion,f.version);assert.equal(next.snapshot().canInstall,false);assert.equal(next.snapshot().canDownload,false);assert.equal(next.snapshot().releaseUrl,null);assert.equal(f.requests.length,before);assert.equal(installed,0);assert(!JSON.stringify(next.snapshot()).includes(root));await assert.rejects(()=>next.stageInstallation(),{code:'UPDATE_INSTALL_UNSUPPORTED'});
 await next.check();assert.equal(next.snapshot().status,'ready');assert.equal(next.snapshot().canInstall,true);assert.equal(f.requests.slice(before).some(x=>x.url.endsWith('.zip')),false);assert.equal(installed,0);
});
test('the official source is checked again before staging a recovered update and no consent is invented',async t=>{
 const {root,f}=await completed(t);let prepared=0,launched=0;const next=service(root,f,{makePlan:async()=>{prepared++;return {planPath:'synthetic only'};},launchHelper:async()=>{launched++;}});
 await next.loadPreviousResult();await next.check();const requests=f.requests.length;await next.stageInstallation();assert.equal(prepared,1);assert.equal(launched,1);assert(f.requests.length>requests);assert(f.requests.slice(requests).some(x=>x.url.endsWith('/releases/tags/v'+f.version)));assert.equal((await fs.readdir(path.join(root,'updates'))).some(x=>x.startsWith('install-')),false);
});
test('an interrupted download has no completed receipt and is not restored after restart',async t=>{
 const root=await temporary(t),f=fixture(),url=f.metadata.assets.find(x=>x.name==='ChartsHub-win32-x64.zip').browser_download_url;
 const updater=service(root,f,{fetcher:async(...args)=>args[0]===url?new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.error(Error('Power interrupted'));}})):f.fetcher(...args)});
 await updater.check();await assert.rejects(()=>updater.download());updater.dispose();const before=f.requests.length,next=service(root,f);await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');assert.equal(next.snapshot().canInstall,false);assert.equal(f.requests.length,before);
 const dirs=await fs.readdir(path.join(root,'updates'));for(const dir of dirs)await assert.rejects(()=>fs.stat(path.join(root,'updates',dir,cache.RECEIPT)),{code:'ENOENT'});
});
for(const scenario of ['malformed','too large','wrong schema','older version','expired','future date','outside URL','changed tree','extra asset'])test('invalid cache is ignored safely: '+scenario,async t=>{
 const value=await completed(t),receipt=JSON.parse(await fs.readFile(value.receipt,'utf8'));
 if(scenario==='malformed')await fs.writeFile(value.receipt,'{');
 else if(scenario==='too large')await fs.writeFile(value.receipt,' '.repeat(cache.MAX_RECEIPT+1));
 else{if(scenario==='wrong schema')receipt.schema=2;if(scenario==='older version')receipt.release.version='0.14.28';if(scenario==='expired')receipt.completedAt=Date.now()-cache.MAX_AGE-10000;if(scenario==='future date')receipt.completedAt=Date.now()+3600000;if(scenario==='outside URL')receipt.release.assets[0].url='https://example.invalid/payload';if(scenario==='changed tree')receipt.release.tree='not a tree';if(scenario==='extra asset')receipt.release.assets.push(receipt.release.assets[0]);await fs.writeFile(value.receipt,JSON.stringify(receipt));}
 const before=value.f.requests.length,next=service(value.root,value.f);await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');assert.equal(next.snapshot().cachedVersion,null);assert.equal(next.snapshot().canInstall,false);assert.equal(value.f.requests.length,before);await next.check();assert.equal(next.snapshot().status,'available');
});
test('same and newer installed versions never restore a cached downgrade',async t=>{const {root,f}=await completed(t);for(const currentVersion of [f.version,'1.0.0']){const next=service(root,f,{currentVersion});await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');await next.check();assert.equal(next.snapshot().status,'current');assert.equal(next.snapshot().canInstall,false);}});
test('same-size archive corruption is refused on explicit verification and can be downloaded again',async t=>{
 const {root,f,archive}=await completed(t),next=service(root,f);await next.loadPreviousResult();const bytes=await fs.readFile(archive);bytes[0]^=1;await fs.writeFile(archive,bytes);await next.check();assert.equal(next.snapshot().status,'available');assert.equal(next.snapshot().canInstall,false);assert.equal(next.snapshot().canDownload,true);await next.download();assert.equal(next.snapshot().status,'ready');
});
test('a changed official release cannot reuse old bytes even when the version number is unchanged',async t=>{
 const {root,f}=await completed(t),next=service(root,f);await next.loadPreviousResult();f.metadata.id++;await next.check();assert.equal(next.snapshot().status,'available');assert.equal(next.snapshot().canInstall,false);assert.equal(next.snapshot().cachedVersion,null);
});
test('an unavailable or unverified official release never unlocks a cached installation',async t=>{
 const {root,f}=await completed(t),next=service(root,f);await next.loadPreviousResult();f.jobs.jobs[0].conclusion='failure';await assert.rejects(()=>next.check(),{code:'UPDATE_BUILD_UNVERIFIED'});assert.equal(next.snapshot().canInstall,false);
});
test('cache refuses hard-linked receipts and archives',async t=>{
 for(const name of ['receipt','archive']){const value=await completed(t),file=value[name];await fs.link(file,path.join(value.root,'untrusted-link'));const next=service(value.root,value.f);await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');assert.equal(next.snapshot().canInstall,false);}
});
test('a linked download directory cannot borrow a receipt outside the update cache',async t=>{
 const value=await completed(t),outside=path.join(value.root,'outside');await fs.rename(value.directory,outside);await fs.symlink(outside,value.directory,process.platform==='win32'?'junction':'dir');const next=service(value.root,value.f);await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');assert.equal(next.snapshot().canInstall,false);
});
test('cache scanning is bounded and ignores temporary files',async t=>{
 const {root,f,directory}=await completed(t),updates=path.join(root,'updates');await fs.rename(path.join(directory,cache.RECEIPT),path.join(directory,'receipt-incomplete.tmp'));assert.equal(await cache.findCompleted({dataDirectory:root,currentVersion:'0.14.29'}),null);
 for(let i=0;i<cache.MAX_ENTRIES;i++)await fs.mkdir(path.join(updates,`download-${i.toString(16).padStart(8,'0')}-1234-4234-8234-123456789abc`));const next=service(root,f);await next.loadPreviousResult();assert.equal(next.snapshot().status,'idle');
});
test('busy operations still block an explicitly reverified download after restart',async t=>{const {root,f}=await completed(t),next=service(root,f,{busyReasons:()=>['library_scanning']});await next.loadPreviousResult();await next.check();assert.equal(next.snapshot().status,'ready');assert.equal(next.snapshot().canInstall,false);await assert.rejects(()=>next.stageInstallation(),{code:'UPDATE_OPERATIONS_ACTIVE'});});
test('disposing during startup never publishes a recovered capability',async t=>{const {root,f}=await completed(t),states=[],next=service(root,f,{onChange:x=>states.push(x)}),loading=next.loadPreviousResult();next.dispose();await loading;assert.equal(states.length,0);assert.equal(next.snapshot().canInstall,false);});
