'use strict';
const fs=require('node:fs').promises,path=require('node:path'),crypto=require('node:crypto');
const releaseApi=require('./update-release.cjs'),paths=require('./update-plan.cjs');
const rollbackApi=require('./update-rollback.cjs');
const {fail}=releaseApi;
const DOWNLOAD_HOSTS=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
async function assetResponse(fetcher,asset,signal){
 let url=asset.url;
 for(let hop=0;hop<5;hop++){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!DOWNLOAD_HOSTS.has(u.hostname))throw fail('DOWNLOAD_ORIGIN');
  const response=await fetcher(url,{credentials:'omit',redirect:'manual',cache:'no-store',signal,headers:{'User-Agent':'ChartsHub-Desktop-Updater'}});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers?.get('location');if(!location)throw fail('DOWNLOAD_ORIGIN');url=new URL(location,url).href;continue;}
  if(!response.ok||!response.body)throw fail('NETWORK');return response;
 }
 throw fail('DOWNLOAD_ORIGIN');
}
async function smallAsset(fetcher,asset,signal){
 const bytes=await releaseApi.boundedBytes(await assetResponse(fetcher,asset,signal),asset.size,signal);
 if(bytes.length!==asset.size||paths.hash(bytes)!==asset.sha256)throw fail('CHECKSUMS_MISMATCH');return bytes;
}
function createUpdateService({currentVersion,platform=process.platform,arch=process.arch,packaged=false,applicationDirectory,dataDirectory,fetcher=globalThis.fetch,onChange=()=>{},busyReasons=()=>[],openExternal=async()=>{},launchHelper=async()=>{},pid=process.pid,clock=()=>Date.now(),makePlan=paths.createPlan,makeRollbackPlan=rollbackApi.createRollbackPlan}={}){
 releaseApi.version(currentVersion);if(typeof fetcher!=='function')throw TypeError('A fetcher is required');
 let release=null,status='idle',error=null,progress=null,controller=null,pending=null,disposed=false,checkedAt=0,lastResult=null,rollback=null;
 const supported=platform==='win32'&&arch==='x64'&&packaged===true;
 const reasons=()=>{try{const list=busyReasons();return Array.isArray(list)&&list.every(x=>typeof x==='string'&&/^[a-z_]{1,60}$/.test(x))?[...new Set(list)]:['state_unavailable'];}catch{return ['state_unavailable'];}};
 const active=()=>['checking','downloading','staging'].includes(status);
 function snapshot(){const blocked=reasons();return {status,currentVersion,latestVersion:release?.version??null,notes:release?.notes??'',releaseUrl:release?.url??null,progress:progress?{...progress}:null,installSupported:supported,canCheck:!disposed&&!active()&&!pending,canDownload:!disposed&&!active()&&!pending&&!!release&&releaseApi.compareVersions(release.version,currentVersion)>0,canInstall:!disposed&&supported&&status==='ready'&&!!release?.download&&!pending&&blocked.length===0,canRollback:!disposed&&supported&&!active()&&!pending&&!!rollback&&blocked.length===0,previousVersion:rollback?.version??null,busyReasons:blocked,error,lastResult:lastResult?{...lastResult}:null};}
 const publish=()=>{try{onChange(snapshot());}catch{}};
 function begin(next){if(disposed||active()||pending)throw fail('BUSY');status=next;error=null;controller=new AbortController();publish();return controller;}
 function finish(operation){if(controller===operation)controller=null;publish();}
 function failed(problem){status='error';progress=null;error=problem?.name==='AbortError'?'UPDATE_CANCELLED':typeof problem?.code==='string'&&/^UPDATE_[A-Z_]+$/.test(problem.code)?problem.code:'UPDATE_NETWORK';}
 async function check(){const operation=begin('checking');try{
  const found=await releaseApi.discoverRelease(fetcher,AbortSignal.any([operation.signal,AbortSignal.timeout(20000)]));if(disposed)throw fail('CANCELLED');
  release=found;checkedAt=clock();status=releaseApi.compareVersions(found.version,currentVersion)>0?'available':'current';progress=null;return snapshot();
 }catch(problem){failed(problem);throw problem;}finally{finish(operation);}}
 async function download(){
  if(!release||releaseApi.compareVersions(release.version,currentVersion)<=0)throw fail('NO_UPDATE');
  if(!supported){if(disposed||active()||pending)throw fail('BUSY');await openExternal(release.url);return snapshot();}
  const operation=begin('downloading');let handle;
  try{
   const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(300000)]);
   release=await releaseApi.revalidateRelease(fetcher,release,signal);
   const manifest=release.assets.find(a=>a.name==='SHA256SUMS.txt');releaseApi.parseChecksums(await smallAsset(fetcher,manifest,signal),release);
   await paths.plain(dataDirectory,{directory:true});const cache=path.join(dataDirectory,'updates');await paths.plain(cache,{directory:true,missing:true});await fs.mkdir(cache,{recursive:true});await paths.plain(cache,{directory:true});
   const directory=path.join(cache,'download-'+crypto.randomUUID());await fs.mkdir(directory);await paths.plain(directory,{directory:true});
   const asset=release.assets.find(a=>a.name==='ChartsHub-win32-x64.zip'),partial=path.join(directory,'ChartsHub-win32-x64.zip.part'),response=await assetResponse(fetcher,asset,signal);
   const declared=response.headers?.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)!==asset.size))throw fail('ARCHIVE_SIZE');
   handle=await fs.open(partial,'wx',0o600);const first=await handle.stat(),hasher=crypto.createHash('sha256');let received=0,lastPublish=0;
   progress={receivedBytes:0,totalBytes:asset.size};publish();
   for await(const part of response.body){signal.throwIfAborted();const bytes=Buffer.from(part);received+=bytes.length;if(received>asset.size)throw fail('ARCHIVE_SIZE');await handle.writeFile(bytes);hasher.update(bytes);progress={receivedBytes:received,totalBytes:asset.size};if(clock()-lastPublish>100){lastPublish=clock();publish();}}
   signal.throwIfAborted();if(received!==asset.size||hasher.digest('hex')!==asset.sha256)throw fail('ARCHIVE_DIGEST');await handle.sync();await handle.close();handle=null;
   const info=await paths.plain(partial);if(info.ino!==first.ino||info.dev!==first.dev||info.size!==received||await paths.fileHash(partial)!==asset.sha256)throw fail('ARCHIVE_CHANGED');
   const final=path.join(directory,asset.name);await paths.plain(final,{missing:true});await fs.rename(partial,final);
   release={...release,download:{cacheDirectory:cache,path:final}};status='ready';checkedAt=clock();return snapshot();
  }catch(problem){failed(problem);throw problem;}finally{if(handle)await handle.close().catch(()=>{});finish(operation);}
 }
 async function stageInstallation(){
  if(!snapshot().canInstall)throw fail(reasons().length?'OPERATIONS_ACTIVE':'INSTALL_UNSUPPORTED');
  const operation=begin('staging');
  try{
   const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(30000)]),downloaded=release.download;
   if(!downloaded||clock()-checkedAt>24*3600000)throw fail('CHECK_AGAIN');
   const checked=await releaseApi.revalidateRelease(fetcher,release,signal);release={...checked,download:downloaded};
   if(reasons().length)throw fail('OPERATIONS_ACTIVE');
   const plan=await makePlan({applicationDirectory,dataDirectory,cacheDirectory:downloaded.cacheDirectory,archivePath:downloaded.path,release,currentVersion,pid});
   signal.throwIfAborted();if(reasons().length)throw fail('OPERATIONS_ACTIVE');
   await launchHelper(plan,signal);if(disposed)throw fail('CANCELLED');pending=plan;return {ready:true,version:release.version};
  }catch(problem){failed(problem);throw problem;}finally{finish(operation);}
 }
 async function authorizeInstallation(){
  if(!pending||disposed)throw fail('INSTALL_NOT_PREPARED');
  const value=pending;await paths.plain(value.planPath);if(await paths.fileHash(value.planPath)!==value.planSha256)throw fail('PLAN_CHANGED');
  await paths.plain(value.authorizationPath,{missing:true});await fs.writeFile(value.authorizationPath,JSON.stringify({planSha256:value.planSha256})+'\n',{flag:'wx',mode:0o600});return true;
 }
 async function stageRollback(){
  if(!snapshot().canRollback)throw fail(reasons().length?'OPERATIONS_ACTIVE':'BACKUP_UNAVAILABLE');const operation=begin('staging');
  try{const plan=await makeRollbackPlan({applicationDirectory,dataDirectory,currentVersion,pid,candidate:rollback});operation.signal.throwIfAborted();if(reasons().length)throw fail('OPERATIONS_ACTIVE');await launchHelper(plan,operation.signal);if(disposed)throw fail('CANCELLED');pending=plan;return {ready:true,version:rollback.version};}
  catch(problem){if(problem?.code?.startsWith('UPDATE_BACKUP_'))rollback=null;failed(problem);throw problem;}finally{finish(operation);}
 }
 async function cancelInstallation(){if(!pending)return;const value=pending;pending=null;try{await paths.plain(value.cancelPath,{missing:true});await fs.writeFile(value.cancelPath,'{}\n',{flag:'wx',mode:0o600});}catch{}status=release?.download?'ready':release?'available':'idle';publish();}
 function cancel(){if(!['checking','downloading'].includes(status)||!controller)return false;controller.abort();return true;}
 async function openRelease(){if(!release||disposed)throw fail('NO_UPDATE');await openExternal(release.url);}
 async function loadPreviousResult(){
  if(!dataDirectory||disposed)return;const cache=path.join(dataDirectory,'updates');
  try{
   await paths.plain(cache,{directory:true});const entries=(await fs.readdir(cache,{withFileTypes:true})).filter(x=>x.isDirectory()&&/^install-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x.name));
   if(entries.length>100)return;const results=[];
   for(const item of entries){const file=path.join(cache,item.name,'result.json');try{const info=await paths.plain(file);if(info.size>16*1024**2)continue;const result=JSON.parse(await fs.readFile(file,'utf8'));if(!['complete','rolled-back','failed','recovery-required'].includes(result.status))continue;releaseApi.version(result.version);results.push({time:info.mtimeMs,status:result.status,version:result.version});}catch{}}
   const latest=results.sort((a,b)=>b.time-a.time)[0];if(latest&&!disposed){lastResult={status:latest.status,version:latest.version};publish();}
  }catch{} // Missing or untrusted receipts never block ordinary startup.
  if(supported&&!disposed){try{rollback=await rollbackApi.findRollback({applicationDirectory,dataDirectory,currentVersion});}catch{rollback=null;}if(!disposed)publish();}
 }
 function dispose(){disposed=true;controller?.abort();}
 return {snapshot,check,download,cancel,openRelease,stageInstallation,stageRollback,authorizeInstallation,cancelInstallation,loadPreviousResult,dispose};
}
module.exports={DOWNLOAD_HOSTS,assetResponse,smallAsset,createUpdateService};
