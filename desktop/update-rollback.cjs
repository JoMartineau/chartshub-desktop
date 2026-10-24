'use strict';
const fs=require('node:fs').promises,path=require('node:path'),crypto=require('node:crypto');
const {plain,within,same,fileHash,treeManifest,readAsarPackage,hash}=require('./update-plan.cjs');
const {version,fail}=require('./update-release.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function manifest(input){
 if(!input||!Array.isArray(input.directories)||!Array.isArray(input.files)||input.fileCount!==input.files.length||input.directories.length+input.files.length>50000)throw fail('BACKUP_INVALID');
 const names=new Set();let total=0;
 const name=value=>{if(typeof value!=='string'||!value||value.includes('\\')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p))||names.has(value.toLowerCase()))throw fail('BACKUP_INVALID');names.add(value.toLowerCase());return value;};
 const directories=input.directories.map(name).sort(),files=input.files.map(entry=>{if(!entry||!Number.isSafeInteger(entry.length)||entry.length<0||entry.length>2*1024**3||typeof entry.sha256!=='string'||! /^[a-f0-9]{64}$/.test(entry.sha256))throw fail('BACKUP_INVALID');total+=entry.length;return {path:name(entry.path),length:entry.length,sha256:entry.sha256};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(total>4*1024**3)throw fail('BACKUP_INVALID');return {directories,files,fileCount:files.length};
}
const equalManifest=(a,b)=>JSON.stringify(manifest(a))===JSON.stringify(manifest(b));
async function document(file){const before=await plain(file);if(before.size>16*1024**2)throw fail('BACKUP_INVALID');const bytes=await fs.readFile(file),after=await plain(file);if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)throw fail('BACKUP_CHANGED');let value;try{value=JSON.parse(bytes);}catch{throw fail('BACKUP_INVALID');}return {value,sha256:hash(bytes)};}
async function verifyRollback({applicationDirectory,dataDirectory,currentVersion,jobDirectory,expectedPlanSha256,expectedReceiptSha256}){
 const cache=path.join(dataDirectory,'updates');await plain(cache,{directory:true});await plain(jobDirectory,{directory:true});
 const match=/^install-([a-f0-9-]{36})$/.exec(path.basename(jobDirectory));if(!match||!UUID.test(match[1])||!same(path.dirname(jobDirectory),cache))throw fail('BACKUP_INVALID');
 const planFile=path.join(jobDirectory,'plan.json'),resultFile=path.join(jobDirectory,'result.json'),a=await document(planFile),b=await document(resultFile),plan=a.value,result=b.value;
 const ready=(await document(path.join(jobDirectory,'ready.json'))).value,authorized=(await document(path.join(jobDirectory,'authorized.json'))).value;
 if(expectedPlanSha256&&a.sha256!==expectedPlanSha256||expectedReceiptSha256&&b.sha256!==expectedReceiptSha256)throw fail('BACKUP_CHANGED');
 if(plan.schema!==2||!['update','rollback'].includes(plan.kind)||plan.id!==match[1]||ready.planSha256!==a.sha256||authorized.planSha256!==a.sha256||!same(plan.applicationDirectory,applicationDirectory)||!same(plan.dataDirectory,dataDirectory)||!same(plan.cacheDirectory,cache)||!same(plan.jobDirectory,jobDirectory)||result.format!=='chartshub-update-result'||result.schema!==2||result.status!=='complete'||result.jobId!==plan.id||result.kind!==plan.kind||result.planSha256!==a.sha256||result.version!==plan.version||result.previousVersion!==plan.currentVersion||result.version!==currentVersion||!same(result.application,applicationDirectory)||!same(result.backup,applicationDirectory+'.backup-'+plan.id)||await fileHash(path.join(jobDirectory,'update-install.ps1'))!==plan.helperSha256)throw fail('BACKUP_INVALID');
 version(result.version);version(result.previousVersion);if(result.version===result.previousVersion||!equalManifest(result.previousManifest,plan.prior))throw fail('BACKUP_INVALID');
 const previous=await readAsarPackage(path.join(result.backup,'resources','app.asar')),current=await readAsarPackage(path.join(applicationDirectory,'resources','app.asar'));
 if(previous.name!=='chartshub-desktop'||previous.version!==result.previousVersion||current.name!=='chartshub-desktop'||current.version!==currentVersion||!equalManifest(await treeManifest(result.backup),result.previousManifest)||!equalManifest(await treeManifest(applicationDirectory),result.installedManifest))throw fail('BACKUP_CHANGED');
 return {version:result.previousVersion,backup:result.backup,sourceManifest:manifest(result.previousManifest),currentManifest:manifest(result.installedManifest),jobDirectory,planSha256:a.sha256,receiptSha256:b.sha256};
}
async function findRollback(options){
 const cache=path.join(options.dataDirectory,'updates');try{await plain(cache,{directory:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}
 const items=(await fs.readdir(cache,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^install-[a-f0-9-]{36}$/.test(e.name));if(items.length>100)return null;
 const observed=[];for(const item of items){try{const file=path.join(cache,item.name,'result.json'),info=await plain(file);observed.push({jobDirectory:path.dirname(file),time:info.mtimeMs});}catch{}}
 for(const item of observed.sort((a,b)=>b.time-a.time)){try{return await verifyRollback({...options,jobDirectory:item.jobDirectory});}catch{}}
 return null;
}
async function createRollbackPlan({applicationDirectory,dataDirectory,currentVersion,pid,candidate,helperSource=path.join(__dirname,'update-install.ps1')}){
 const checked=await verifyRollback({applicationDirectory,dataDirectory,currentVersion,jobDirectory:candidate.jobDirectory,expectedPlanSha256:candidate.planSha256,expectedReceiptSha256:candidate.receiptSha256});
 const cache=path.join(dataDirectory,'updates');if(within(applicationDirectory,dataDirectory)||same(applicationDirectory,dataDirectory)||!Number.isSafeInteger(pid)||pid<1)throw fail('PATH_UNSAFE');
 const id=crypto.randomUUID(),jobDirectory=path.join(cache,'install-'+id);await fs.mkdir(jobDirectory);await plain(jobDirectory,{directory:true});const helperBytes=await fs.readFile(helperSource),helperPath=path.join(jobDirectory,'update-install.ps1');await fs.writeFile(helperPath,helperBytes,{flag:'wx',mode:0o600});
 const plan={schema:2,kind:'rollback',id,applicationDirectory,dataDirectory,cacheDirectory:cache,jobDirectory,currentVersion,version:checked.version,pid,prior:checked.currentManifest,sourceBackup:checked.backup,sourceManifest:checked.sourceManifest,sourceJobDirectory:checked.jobDirectory,sourcePlanSha256:checked.planSha256,sourceReceiptSha256:checked.receiptSha256,helperSha256:hash(helperBytes),createdAt:new Date().toISOString()};
 const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n'),planPath=path.join(jobDirectory,'plan.json');if(bytes.length>16*1024**2)throw fail('APPLICATION_TOO_LARGE');await fs.writeFile(planPath,bytes,{flag:'wx',mode:0o600});return {plan,planPath,planSha256:hash(bytes),helperPath,authorizationPath:path.join(jobDirectory,'authorized.json'),readyPath:path.join(jobDirectory,'ready.json'),cancelPath:path.join(jobDirectory,'cancelled.json'),receiptPath:path.join(jobDirectory,'result.json')};
}
module.exports={manifest,equalManifest,verifyRollback,findRollback,createRollbackPlan};
