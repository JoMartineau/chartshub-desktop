'use strict';
// A receipt remembers a completed download, never permission to install it.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const releaseApi=require('./update-release.cjs'),paths=require('./update-plan.cjs');
const DIRECTORY=/^download-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECEIPT='completed.json',MAX_RECEIPT=128*1024,MAX_ENTRIES=32,MAX_AGE=30*24*3600000;
function validate(value,currentVersion,now){
 if(!value||value.schema!==1||!Number.isSafeInteger(value.completedAt)||value.completedAt<=0||value.completedAt>now+60000||now-value.completedAt>MAX_AGE)throw releaseApi.fail('CACHE_INVALID');
 const r=value.release;
 if(!r||!/^[a-f0-9]{40}$/.test(r.tree)||!Number.isSafeInteger(r.runId)||r.runId<1||!Array.isArray(r.assets))throw releaseApi.fail('CACHE_INVALID');
 // Use the same official-origin and asset validation as the network updater.
 const release=releaseApi.validateRelease({id:r.id,tag_name:r.tag,target_commitish:r.commit,html_url:r.url,draft:false,prerelease:false,published_at:r.publishedAt,body:r.notes,
  assets:r.assets.map(a=>({id:a.id,name:a.name,state:'uploaded',size:a.size,digest:'sha256:'+a.sha256,browser_download_url:a.url}))});
 if(r.version!==release.version||releaseApi.compareVersions(release.version,currentVersion)<=0)throw releaseApi.fail('CACHE_INVALID');
 return {schema:1,completedAt:value.completedAt,release:{...release,tree:r.tree,runId:r.runId}};
}
function sameRelease(a,b){return ['id','version','tag','commit','tree','runId'].every(key=>a[key]===b[key])&&JSON.stringify(a.assets)===JSON.stringify(b.assets);}
async function readReceipt(directory,currentVersion,now){
 await paths.plain(directory,{directory:true});
 const file=path.join(directory,RECEIPT),info=await paths.plain(file);if(info.size<1||info.size>MAX_RECEIPT)throw releaseApi.fail('CACHE_INVALID');
 const handle=await fs.open(file,'r');let bytes;
 try{const opened=await handle.stat();if(opened.ino!==info.ino||opened.dev!==info.dev||opened.nlink!==1)throw releaseApi.fail('CACHE_INVALID');const buffer=Buffer.alloc(MAX_RECEIPT+1);let length=0;while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}bytes=buffer.subarray(0,length);const after=await handle.stat();if(bytes.length>MAX_RECEIPT||bytes.length!==info.size||after.nlink!==1||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw releaseApi.fail('CACHE_INVALID');}
 finally{await handle.close();}
 await paths.plain(file);if(await paths.fileHash(file)!==paths.hash(bytes))throw releaseApi.fail('CACHE_INVALID');
 const value=validate(JSON.parse(bytes.toString('utf8')),currentVersion,now);
 const archive=path.join(directory,'ChartsHub-win32-x64.zip'),asset=value.release.assets.find(a=>a.name==='ChartsHub-win32-x64.zip');
 const archiveInfo=await paths.plain(archive);if(archiveInfo.size!==asset.size)throw releaseApi.fail('CACHE_INVALID');
 return {...value,directory,archive};
}
async function findCompleted({dataDirectory,currentVersion,now=Date.now()}={}){
 try{
  await paths.plain(dataDirectory,{directory:true});const cache=path.join(dataDirectory,'updates');await paths.plain(cache,{directory:true});
  const directories=(await fs.readdir(cache,{withFileTypes:true})).filter(e=>DIRECTORY.test(e.name));
  // Fail closed rather than walk an unbounded cache on startup.
  if(directories.length>MAX_ENTRIES)return null;
  const candidates=[];for(const entry of directories){if(!entry.isDirectory())continue;try{candidates.push(await readReceipt(path.join(cache,entry.name),currentVersion,now));}catch{}}
  return candidates.sort((a,b)=>b.completedAt-a.completedAt)[0]??null;
 }catch{return null;}
}
async function saveCompleted({directory,release,currentVersion,now=Date.now()}={}){
 if(!DIRECTORY.test(path.basename(directory)))throw releaseApi.fail('CACHE_INVALID');
 await paths.plain(directory,{directory:true});
 const clean=validate({schema:1,completedAt:now,release},currentVersion,now),bytes=Buffer.from(JSON.stringify(clean)+'\n');
 if(bytes.length>MAX_RECEIPT)throw releaseApi.fail('CACHE_INVALID');
 const archive=path.join(directory,'ChartsHub-win32-x64.zip'),asset=clean.release.assets.find(a=>a.name==='ChartsHub-win32-x64.zip');
 const info=await paths.plain(archive);if(info.size!==asset.size||await paths.fileHash(archive)!==asset.sha256)throw releaseApi.fail('CACHE_INVALID');
 const file=path.join(directory,RECEIPT),temporary=path.join(directory,'receipt-'+crypto.randomUUID()+'.tmp');
 await paths.plain(file,{missing:true});const handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 await paths.plain(directory,{directory:true});await paths.plain(temporary);await paths.plain(file,{missing:true});await fs.rename(temporary,file);
 return {...clean,directory,archive};
}
async function verifyCompleted(candidate,official,{currentVersion,now=Date.now()}={}){
 // Metadata from disk is never trusted until the current official release agrees.
 const fresh=await readReceipt(candidate.directory,currentVersion,now);
 if(!sameRelease(fresh.release,official))throw releaseApi.fail('RELEASE_CHANGED');
 const asset=official.assets.find(a=>a.name==='ChartsHub-win32-x64.zip');
 if(await paths.fileHash(fresh.archive)!==asset.sha256)throw releaseApi.fail('ARCHIVE_DIGEST');
 return {cacheDirectory:path.dirname(fresh.directory),path:fresh.archive};
}
module.exports={RECEIPT,MAX_RECEIPT,MAX_ENTRIES,MAX_AGE,findCompleted,saveCompleted,verifyCompleted};
