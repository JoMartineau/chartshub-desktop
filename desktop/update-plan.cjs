'use strict';
const virtualFs=require('node:fs');
// Electron treats app.asar as a virtual directory. Installation guards and
// manifests must inspect the real archive file, while the shipped helper is
// read through Electron's virtual filesystem before being copied outside it.
const fs=process.versions.electron?require('original-fs'):virtualFs,fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./update-release.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root,file)=>{const r=path.relative(root,file);return !!r&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};
async function plain(file,{directory=false,missing=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\u0000-\u001f]/.test(file)||file.startsWith('\\\\'))throw fail('PATH_UNSAFE');
 let current=path.parse(file).root;
 for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){
  if(/[. ]$/.test(part)||/[<>:"|?*]/.test(part))throw fail('PATH_UNSAFE');current=path.join(current,part);
  let stat;try{stat=await fsp.lstat(current);}catch(e){if(e.code==='ENOENT'&&missing)continue;throw e;}
  if(stat.isSymbolicLink())throw fail('PATH_UNSAFE');
 }
 let stat;try{stat=await fsp.lstat(file);}catch(e){if(e.code==='ENOENT'&&missing)return null;throw e;}
 if((directory?!stat.isDirectory():!stat.isFile())||(!directory&&stat.nlink!==1)||!same(await fsp.realpath(file),path.resolve(file)))throw fail('PATH_UNSAFE');return stat;
}
async function fileHash(file){
 const before=await plain(file),hasher=crypto.createHash('sha256'),handle=await fsp.open(file,'r');
 try{const initial=await handle.stat();if(initial.ino!==before.ino||initial.dev!==before.dev||initial.size!==before.size)throw fail('FILES_CHANGED');for await(const bytes of handle.createReadStream({autoClose:false}))hasher.update(bytes);
  const after=await plain(file);if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw fail('FILES_CHANGED');
  return hasher.digest('hex');
 }finally{await handle.close();}
}
async function treeManifest(root){
 await plain(root,{directory:true});const directories=[],files=[],queue=[root];let bytes=0;
 // Refuse song data by name before reading any file contents.
 const names=[];
 while(queue.length){const directory=queue.pop();await plain(directory,{directory:true});for(const item of await fsp.readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name),relative=path.relative(root,file).split(path.sep).join('/');
  if(!within(root,file)||item.isSymbolicLink()||item.name.toLowerCase()==='songs'||/^(song\.ini|notes\.(chart|mid)|.*\.sng)$/i.test(item.name))throw fail('SONGS_IN_APPLICATION');
  if(item.isDirectory()){await plain(file,{directory:true});directories.push(relative);queue.push(file);}else{const stat=await plain(file);names.push({file,path:relative,length:stat.size});bytes+=stat.size;}
  if(names.length+directories.length>50000||bytes>4*1024**3)throw fail('APPLICATION_TOO_LARGE');
 }}
 for(const entry of names)files.push({path:entry.path,length:entry.length,sha256:await fileHash(entry.file)});
 return {directories:directories.sort(),files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),fileCount:files.length};
}
async function readAsarPackage(file){
 await plain(file);const handle=await fsp.open(file,'r');
 try{
  const stat=await handle.stat(),prefix=Buffer.alloc(16);if((await handle.read(prefix,0,16,0)).bytesRead!==16||prefix.readUInt32LE(0)!==4)throw fail('ASAR_INVALID');
  const headerSize=prefix.readUInt32LE(4),payload=prefix.readUInt32LE(8),length=prefix.readUInt32LE(12);
  if(headerSize<8||headerSize>32*1024**2||8+headerSize>stat.size||payload!==headerSize-4||length<2||length>headerSize-8)throw fail('ASAR_INVALID');
  const header=Buffer.alloc(length);if((await handle.read(header,0,length,16)).bytesRead!==length)throw fail('ASAR_INVALID');
  const entry=JSON.parse(header.toString('utf8')).files?.['package.json'];
  if(!entry||Object.hasOwn(entry,'link')||Object.hasOwn(entry,'files')||Object.hasOwn(entry,'unpacked')&&entry.unpacked!==false||typeof entry.offset!=='string'||!/^\d+$/.test(entry.offset)||!Number.isSafeInteger(entry.size)||entry.size<2||entry.size>2*1024**2)throw fail('ASAR_INVALID');
  const offset=Number(entry.offset),start=8+headerSize;if(!Number.isSafeInteger(offset)||offset>stat.size-start-entry.size)throw fail('ASAR_INVALID');
  const body=Buffer.alloc(entry.size);if((await handle.read(body,0,body.length,start+offset)).bytesRead!==body.length)throw fail('ASAR_INVALID');return JSON.parse(body.toString('utf8'));
 }finally{await handle.close();}
}
async function createPlan({applicationDirectory,dataDirectory,cacheDirectory,archivePath,release,currentVersion,pid,helperSource=path.join(__dirname,'update-install.ps1')}){
 await plain(applicationDirectory,{directory:true});await plain(dataDirectory,{directory:true});await plain(cacheDirectory,{directory:true});await plain(archivePath);
 if(applicationDirectory===path.parse(applicationDirectory).root||within(applicationDirectory,dataDirectory)||same(applicationDirectory,dataDirectory)||within(applicationDirectory,cacheDirectory)||!within(cacheDirectory,archivePath)||!Number.isSafeInteger(pid)||pid<1)throw fail('PATH_UNSAFE');
 await plain(path.join(applicationDirectory,'ChartsHub.exe'));
 const current=await readAsarPackage(path.join(applicationDirectory,'resources','app.asar'));
 if(current.name!=='chartshub-desktop'||current.version!==currentVersion)throw fail('APPLICATION_IDENTITY');
 const expected=release.assets.find(a=>a.name==='ChartsHub-win32-x64.zip');if(!expected||await fileHash(archivePath)!==expected.sha256||(await plain(archivePath)).size!==expected.size)throw fail('ARCHIVE_CHANGED');
 const prior=await treeManifest(applicationDirectory),id=crypto.randomUUID(),jobDirectory=path.join(cacheDirectory,'install-'+id);
 await plain(jobDirectory,{directory:true,missing:true});await fsp.mkdir(jobDirectory);await plain(jobDirectory,{directory:true});
 const helperBytes=await virtualFs.promises.readFile(helperSource),helperPath=path.join(jobDirectory,'update-install.ps1');await fsp.writeFile(helperPath,helperBytes,{flag:'wx',mode:0o600});
 const plan={schema:2,kind:'update',id,applicationDirectory,dataDirectory,cacheDirectory,jobDirectory,archivePath,archiveSha256:expected.sha256,archiveBytes:expected.size,currentVersion,version:release.version,commit:release.commit,tree:release.tree,releaseId:release.id,pid,prior,helperSha256:hash(helperBytes),createdAt:new Date().toISOString()};
 const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');if(bytes.length>16*1024**2)throw fail('APPLICATION_TOO_LARGE');
 const planPath=path.join(jobDirectory,'plan.json');await fsp.writeFile(planPath,bytes,{flag:'wx',mode:0o600});
 return {plan,planPath,planSha256:hash(bytes),helperPath,authorizationPath:path.join(jobDirectory,'authorized.json'),readyPath:path.join(jobDirectory,'ready.json'),cancelPath:path.join(jobDirectory,'cancelled.json'),receiptPath:path.join(jobDirectory,'result.json')};
}
module.exports={hash,same,within,plain,fileHash,treeManifest,readAsarPackage,createPlan};
