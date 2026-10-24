'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=2*1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GROUP_FILES=Object.freeze({overlay:'settings.json',profiles:'overlay-profiles.json',panels:'floating-panels.json',bloom:'ui-bloom.json',requests:'song-request-access.json'});
const WIDGETS=Object.freeze({'song.title':'song-title','song.artist':'song-artist','song.charter':'song-charter','song.instrument':'song-instrument','song.difficulty':'song-difficulty'});
const fail=code=>Object.assign(Error(code),{code:'BACKUP_'+code});
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,names)=>object(x)&&Object.keys(x).length===names.length&&Object.keys(x).every(k=>names.includes(k));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const identity=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const originalLimit=key=>key==='profiles'?5*1024*1024:MAX_BYTES;
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function writeNew(file,bytes){const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
async function checkedPath(file,{directory=false,missing=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\x00-\x1f]/.test(file)||file.startsWith('\\\\'))throw fail('PATH_UNSAFE');
 let current=path.parse(file).root;
 for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){
  if(/[. ]$/.test(part)||part==='.'||part==='..'||/[<>:"|?*]/.test(part))throw fail('PATH_UNSAFE');current=path.join(current,part);
  try{const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw fail('PATH_UNSAFE');}catch(e){if(e.code!=='ENOENT'||!missing)throw e;}
 }
 let stat;try{stat=await fs.lstat(file,{bigint:true});}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
 if((directory?!stat.isDirectory():!stat.isFile())||(!directory&&stat.nlink!==1n)||!same(await fs.realpath(file),path.resolve(file)))throw fail('PATH_UNSAFE');return stat;
}
async function readSource(file,limit=MAX_BYTES){
 let before;try{before=await checkedPath(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(before.size>BigInt(limit))throw fail('TOO_LARGE');const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  if(identity(await handle.stat({bigint:true}))!==identity(before))throw fail('CHANGED');
  const bytes=Buffer.alloc(Number(before.size)+1);let offset=0;
  while(offset<bytes.length){const chunk=await handle.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)break;offset+=chunk.bytesRead;}
  if(offset!==Number(before.size)||identity(await handle.stat({bigint:true}))!==identity(before)||identity(await checkedPath(file))!==identity(before))throw fail('CHANGED');
  return {bytes:bytes.subarray(0,offset),identity:identity(before),sha256:sha(bytes.subarray(0,offset))};
 }finally{await handle.close();}
}
function parse(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));}catch{throw fail('INVALID');}}
async function createConfigBackup({directory,version,clock=()=>Date.now(),hook=async()=>{},onChange=()=>{},isProcessAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))throw fail('INVALID');
 directory=path.resolve(directory);
 const [{validateSettings},{createDefaultWidgets},{createDefaultTheme},{createDefaultStream},bloom]=await Promise.all([
  import('../companion/dist/storage/SettingsRepository.js'),import('../companion/dist/widgets/core/index.js'),import('../companion/dist/themes/ThemeService.js'),import('../companion/dist/overlay/stream/StreamConfig.js'),import('../companion/ui/ui-bloom-model.js')
 ]);
 const defaults=createDefaultWidgets(),defaultDocument={version:3,widgets:defaults,theme:createDefaultTheme(),stream:createDefaultStream(defaults)};
 const {DEFAULT_WIDGET,validateWidget}=require('../companion/song-request-widget.cjs');
 const {DEFAULT_RULES,INSTRUMENTS,DIFFICULTIES}=require('../companion/song-requests.cjs');
 let preview=null,busy=false,expiryTimer=null;
 const notify=()=>queueMicrotask(()=>{try{onChange(status());}catch{}});
 function expirePreview(){if(preview&&(clock()-preview.created>=10*60000||clock()<preview.created)){preview=null;clearTimeout(expiryTimer);expiryTimer=null;notify();}}
 function assertPreview(id){expirePreview();if(!preview||preview.id!==id||!UUID.test(id))throw fail('PREVIEW_EXPIRED');return true;}
 const requireKeys=(value,names)=>{if(!keys(value,names))throw fail('INVALID');};
 function portableSettings(value,fromDisk=false){
  if(!object(value)||!Array.isArray(value.widgets))throw fail('INVALID');
  if(!fromDisk){requireKeys(value,['widgets','theme','stream']);requireKeys(value.stream,['canvas','layout']);}
  // Current widgets have no configurable strings. Drop arbitrary legacy config
  // on export; imports must contain the exact empty portable configuration.
  const widgets=value.widgets.map(w=>{
   if(!object(w)||WIDGETS[w.type]!==w.id)throw fail('UNSUPPORTED_WIDGET');
   if(!fromDisk&&(!keys(w.config,[])||Object.keys(w).some(k=>!['id','type','enabled','locked','position','size','visibility','gameplayVisibility','style','config'].includes(k))))throw fail('INVALID');
   return {...w,config:{}};
  });
  let normalized;try{normalized=validateSettings(fromDisk?{...value,widgets}:{version:3,widgets,theme:value.theme,stream:{port:38473,canvas:value.stream.canvas,layout:value.stream.layout}});}catch{throw fail('INVALID');}
  return {widgets:normalized.widgets,theme:normalized.theme,stream:{canvas:normalized.stream.canvas,layout:normalized.stream.layout}};
 }
 function profiles(value,fromDisk=false){
  if(fromDisk){if(!keys(value,['version','revision','items'])||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0)throw fail('INVALID');}
  else requireKeys(value,['items']);
  if(!Array.isArray(value.items)||value.items.length>20)throw fail('INVALID');const ids=new Set(),names=new Set();
  return {items:value.items.map((item,index)=>{
   requireKeys(item,['id','name','updatedAt','document']);
   if(typeof item.id!=='string'||!UUID.test(item.id)||ids.has(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>40||typeof item.updatedAt!=='string'||!Number.isFinite(Date.parse(item.updatedAt))||new Date(item.updatedAt).toISOString()!==item.updatedAt)throw fail('INVALID');
   let name=item.name.normalize('NFC').trim();
   if(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\\/:]/.test(name)){if(!fromDisk)throw fail('INVALID');name='Profile '+(index+1);}
   if(names.has(name.toLowerCase()))throw fail('INVALID');ids.add(item.id);names.add(name.toLowerCase());
   return {id:item.id,name,updatedAt:item.updatedAt,document:portableSettings(item.document,false)};
  })};
 }
 function panels(value,fromDisk=false){
  const names=['catalogue','filters','player'];let appearance=value;
  if(fromDisk){if(!keys(value,['version','revision','appearance'])||![1,2].includes(value.version)||!Number.isSafeInteger(value.revision)||value.revision<0)throw fail('INVALID');appearance=value.appearance;if(value.version===1){requireKeys(appearance,['catalogue','filters']);appearance={...appearance,player:{backgroundColor:'#151719e6',textColor:'#eef1f2',fontFamily:'system',fontSize:14}};}}
  requireKeys(appearance,names);
  return Object.fromEntries(names.map(name=>{const p=appearance[name];requireKeys(p,['backgroundColor','textColor','fontFamily','fontSize']);if(typeof p.backgroundColor!=='string'||!/^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(p.backgroundColor)||typeof p.textColor!=='string'||!/^#[a-f0-9]{6}$/i.test(p.textColor)||!['system','arial','verdana','georgia','consolas'].includes(p.fontFamily)||!Number.isInteger(p.fontSize)||p.fontSize<10||p.fontSize>24)throw fail('INVALID');return [name,{backgroundColor:p.backgroundColor.toLowerCase(),textColor:p.textColor.toLowerCase(),fontFamily:p.fontFamily,fontSize:p.fontSize}];}));
 }
 function normalizeGroup(key,value,fromDisk=false){
  if(key==='overlay')return portableSettings(value,fromDisk);
  if(key==='profiles')return profiles(value,fromDisk);
  if(key==='panels')return panels(value,fromDisk);
  if(key==='bloom'){const result=bloom.validate(value);if(!result)throw fail('INVALID');return result;}
  if(key==='requests'){
   if(!fromDisk){try{return validateWidget(value);}catch{throw fail('INVALID');}}
   const allowed=value?.version===1?['version','port','rules','ingestToken','readToken']:['version','port','rules','ingestToken','readToken','widget'];
   if(!keys(value,allowed)||![1,2].includes(value.version)||!Number.isSafeInteger(value.port)||value.port<1024||value.port>65535||typeof value.ingestToken!=='string'||typeof value.readToken!=='string'||! /^[a-f0-9]{64}$/.test(value.ingestToken)||! /^[a-f0-9]{64}$/.test(value.readToken)||value.ingestToken===value.readToken||!keys(value.rules,['maxDurationMinutes','instrument','difficulty'])||value.rules.maxDurationMinutes!==null&&(!Number.isSafeInteger(value.rules.maxDurationMinutes)||value.rules.maxDurationMinutes<1||value.rules.maxDurationMinutes>60)||!INSTRUMENTS.includes(value.rules.instrument)||!DIFFICULTIES.includes(value.rules.difficulty))throw fail('INVALID');
   try{return value.version===1?{...DEFAULT_WIDGET}:validateWidget(value.widget);}catch{throw fail('INVALID');}
  }
  throw fail('INVALID');
 }
 function document(value){
  requireKeys(value,['format','version','sourceVersion','createdAt','groups']);
  if(value.format!=='chartshub-configuration'||value.version!==1||typeof value.sourceVersion!=='string'||value.sourceVersion.length>24||!/^\d+\.\d+\.\d+$/.test(value.sourceVersion)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||new Date(value.createdAt).toISOString()!==value.createdAt||!object(value.groups)||!Object.keys(value.groups).length||Object.keys(value.groups).some(k=>!Object.hasOwn(GROUP_FILES,k)))throw fail('INVALID');
  return {format:value.format,version:1,sourceVersion:value.sourceVersion,createdAt:value.createdAt,groups:Object.fromEntries(Object.entries(value.groups).map(([key,value])=>[key,normalizeGroup(key,value)]))};
 }
 function summary(value,id){return {id,createdAt:value.createdAt,sourceVersion:value.sourceVersion,groups:Object.entries(value.groups).map(([key,value])=>({key,count:key==='overlay'?value.widgets.length:key==='profiles'?value.items.length:key==='panels'?3:1}))};}
 async function readAll(){
  const directoryStat=await checkedPath(directory,{directory:true});const result={};
  for(const [key,file]of Object.entries(GROUP_FILES))result[key]=await readSource(path.join(directory,file),originalLimit(key));
  const after=await checkedPath(directory,{directory:true});if(directoryStat.dev!==after.dev||directoryStat.ino!==after.ino)throw fail('CHANGED');return result;
 }
 async function assertSource(file,expected){const current=await readSource(file,5*1024*1024);if((current?.identity??null)!==(expected?.identity??null)||(current?.sha256??null)!==(expected?.sha256??null))throw fail('CHANGED');}
 async function exportDocument(){
  if(busy)throw fail('BUSY');busy=true;
  try{const source=await readAll(),groups={};for(const [key,input]of Object.entries(source))if(input)groups[key]=normalizeGroup(key,parse(input.bytes),true);if(!groups.overlay)groups.overlay=portableSettings(defaultDocument,true);
   for(const [key,input]of Object.entries(source))await assertSource(path.join(directory,GROUP_FILES[key]),input);
   const result=document({format:'chartshub-configuration',version:1,sourceVersion:version,createdAt:new Date(clock()).toISOString(),groups});const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');if(bytes.length>MAX_BYTES)throw fail('TOO_LARGE');return {bytes,summary:summary(result,null)};
  }finally{busy=false;}
 }
 async function previewBytes(bytes){
  if(busy)throw fail('BUSY');busy=true;
  try{if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES)throw fail('TOO_LARGE');const input=document(parse(bytes)),source=await readAll();
   // Validate current files too: never overwrite unknown future versions.
   for(const [key]of Object.entries(input.groups))if(source[key])normalizeGroup(key,parse(source[key].bytes),true);
   clearTimeout(expiryTimer);preview={id:crypto.randomUUID(),created:clock(),document:input,source};expiryTimer=setTimeout(()=>expirePreview(),10*60000);expiryTimer.unref?.();notify();return summary(input,preview.id);
  }finally{busy=false;}
 }
 async function previewFile(file){const source=await readSource(file);if(!source)throw fail('INVALID');return previewBytes(source.bytes);}
 function status(){expirePreview();return {busy,preview:preview?summary(preview.document,preview.id):null};}
 function cancel(id){if(preview?.id===id){preview=null;clearTimeout(expiryTimer);expiryTimer=null;notify();}}
 function diskDocument(key,value,current){
  if(key==='overlay'){const old=current?validateSettings(parse(current.bytes)):defaultDocument;return {version:3,...value,stream:{port:old.stream.port,...value.stream}};}
  if(key==='profiles'){const old=current?parse(current.bytes):{revision:0};if(old.revision>=Number.MAX_SAFE_INTEGER)throw fail('INVALID');return {version:1,revision:old.revision+1,items:value.items};}
  if(key==='panels'){const old=current?parse(current.bytes):{revision:0};if(old.revision>=Number.MAX_SAFE_INTEGER)throw fail('INVALID');return {version:2,revision:old.revision+1,appearance:value};}
  if(key==='requests'){
   const old=current?parse(current.bytes):{port:38474,rules:{...DEFAULT_RULES},ingestToken:crypto.randomBytes(32).toString('hex'),readToken:crypto.randomBytes(32).toString('hex')};
   return {version:2,port:old.port,rules:old.rules,ingestToken:old.ingestToken,readToken:old.readToken,widget:value};
  }
  return value;
 }
 async function apply(id,{quiesced=false}={}){
  assertPreview(id);if(busy||quiesced!==true)throw fail('PREVIEW_EXPIRED');
  const selected=preview;busy=true;let lock=null,lockIdentity=null,transaction=null,pendingMarker=null,pendingMarkerSha=null,journalSha=null;const changed=[],transactionId=crypto.randomUUID();
  try{
   await checkedPath(directory,{directory:true});const lockPath=path.join(directory,'.configuration-import.lock');await checkedPath(lockPath,{missing:true});lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({version:1,pid:process.pid,transactionId})+'\n');await lock.sync();lockIdentity=identity(await lock.stat({bigint:true}));
   for(const [key]of Object.entries(selected.document.groups))await assertSource(path.join(directory,GROUP_FILES[key]),selected.source[key]);
   const parent=path.join(directory,'.configuration-backups');await checkedPath(parent,{directory:true,missing:true});await fs.mkdir(parent,{recursive:true});await checkedPath(parent,{directory:true});transaction=path.join(parent,transactionId);await fs.mkdir(transaction);await checkedPath(transaction,{directory:true});
   const entries=[];
   for(const [key,value]of Object.entries(selected.document.groups)){
    const old=selected.source[key],filename=GROUP_FILES[key],bytes=Buffer.from(JSON.stringify(diskDocument(key,value,old),null,2)+'\n');if(bytes.length>MAX_BYTES)throw fail('TOO_LARGE');
    const staged=path.join(transaction,key+'.new.json');await writeNew(staged,bytes);if(old)await writeNew(path.join(transaction,key+'.original.json'),old.bytes);entries.push({key,filename,staged,bytes,old,newSha:sha(bytes),moved:path.join(transaction,key+'.moved.json')});
   }
   const journalBytes=Buffer.from(JSON.stringify({version:1,state:'prepared',groups:entries.map(e=>({key:e.key,oldSha:e.old?.sha256??null,newSha:e.newSha}))})+'\n');journalSha=sha(journalBytes);await writeNew(path.join(transaction,'journal.json'),journalBytes);
   // Only this bounded active index is scanned at startup. Historical copies
   // are retained without turning 101 successful restores into a startup error.
   const pendingDirectory=path.join(directory,'.configuration-pending');await checkedPath(pendingDirectory,{directory:true,missing:true});await fs.mkdir(pendingDirectory,{recursive:true});await checkedPath(pendingDirectory,{directory:true});pendingMarker=path.join(pendingDirectory,transactionId+'.json');
   const markerBytes=Buffer.from(JSON.stringify({version:1,id:transactionId,journalSha256:journalSha})+'\n');pendingMarkerSha=sha(markerBytes);await writeNew(pendingMarker,markerBytes);
   await hook('prepared',{transaction});
   for(const entry of entries){
    const target=path.join(directory,entry.filename);await assertSource(target,entry.old);const change={...entry,target,newIdentity:null,oldMoved:false,newWritten:false};changed.push(change);
    if(entry.old){await fs.rename(target,entry.moved);change.oldMoved=true;const moved=await readSource(entry.moved,originalLimit(entry.key));if(moved?.sha256!==entry.old.sha256)throw fail('CHANGED');}
    await hook('original-moved',{key:entry.key,target,transaction});
    // Atomic, exclusive publication: never replace a concurrently created file.
    await fs.link(entry.staged,target);change.newWritten=true;await fs.unlink(entry.staged);const written=await readSource(target);if(written?.sha256!==entry.newSha)throw fail('CHANGED');change.newIdentity=written.identity;
    await hook('written',{key:entry.key,target,transaction});
   }
   for(const entry of changed){const current=await readSource(entry.target);if(current?.sha256!==entry.newSha||current?.identity!==entry.newIdentity)throw fail('CHANGED');}
   await writeNew(path.join(transaction,'complete.json'),JSON.stringify({version:2,state:'complete',journalSha256:journalSha})+'\n');await removePending(pendingMarker,pendingMarkerSha).catch(()=>{});preview=null;clearTimeout(expiryTimer);expiryTimer=null;notify();return {applied:true,groups:Object.keys(selected.document.groups)};
  }catch(problem){
   let recovery=false;
   for(const entry of changed.reverse()){
    try{
     await finishOwnLink(entry.staged,entry.target,entry.newSha);
     const moved=entry.oldMoved?await readSource(entry.moved,originalLimit(entry.key)):null;if(entry.oldMoved&&moved?.sha256!==entry.old.sha256)throw fail('CHANGED');
     const current=await readSource(entry.target,originalLimit(entry.key));
     if(entry.newWritten){if(current?.sha256!==entry.newSha||entry.newIdentity&&current?.identity!==entry.newIdentity)throw fail('CHANGED');await fs.rename(entry.target,path.join(transaction,entry.key+'.failed.json'));}
     else if(current)throw fail('CHANGED');
     if(entry.oldMoved){await fs.link(entry.moved,entry.target);await fs.unlink(entry.moved);}
    }catch{recovery=true;}
   }
   if(transaction){let sealed=false;try{await writeNew(path.join(transaction,'failed.json'),JSON.stringify({version:2,state:recovery?'recovery-required':'rolled-back',journalSha256:journalSha})+'\n');sealed=true;}catch{}if(!recovery&&sealed&&pendingMarker)await removePending(pendingMarker,pendingMarkerSha).catch(()=>{});}
   if(recovery)throw fail('RECOVERY_REQUIRED');throw problem?.code?.startsWith('BACKUP_')?problem:fail('WRITE_FAILED');
  }finally{
   if(lock){await lock.close();const file=path.join(directory,'.configuration-import.lock');try{if(identity(await checkedPath(file))===lockIdentity)await fs.unlink(file);}catch{}}
   busy=false;
  }
 }
 async function finishOwnLink(staged,target,expectedHash){
  let a,b;try{a=await fs.lstat(staged,{bigint:true});b=await fs.lstat(target,{bigint:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(a.isSymbolicLink()||b.isSymbolicLink()||!a.isFile()||!b.isFile())throw fail('PATH_UNSAFE');
  if(a.nlink===2n&&b.nlink===2n&&a.ino===b.ino&&a.dev===b.dev){
   await checkedPath(path.dirname(staged),{directory:true});await checkedPath(path.dirname(target),{directory:true});if(a.size>BigInt(MAX_BYTES)||sha(await fs.readFile(staged))!==expectedHash)throw fail('CHANGED');
   const again=await fs.lstat(staged,{bigint:true});if(identity(again)!==identity(a))throw fail('CHANGED');await fs.unlink(staged);
  }
 }
 async function removePending(file,expectedSha){const current=await readSource(file,4096);if(!current||current.sha256!==expectedSha)throw fail('RECOVERY_REQUIRED');await assertSource(file,current);await fs.unlink(file);}
 async function recoverPending(){
  try{await checkedPath(directory,{directory:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  const lockPath=path.join(directory,'.configuration-import.lock'),oldLock=await readSource(lockPath,4096);
  if(oldLock){const lock=parse(oldLock.bytes);if(!keys(lock,['version','pid','transactionId'])||lock.version!==1||!Number.isSafeInteger(lock.pid)||lock.pid<1||!UUID.test(lock.transactionId)||isProcessAlive(lock.pid))throw fail('RECOVERY_REQUIRED');}
  const parent=path.join(directory,'.configuration-backups'),pendingDirectory=path.join(directory,'.configuration-pending');let folders;
  try{await checkedPath(pendingDirectory,{directory:true});folders=await fs.readdir(pendingDirectory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')folders=[];else throw e;}
  if(folders.length>100)throw fail('RECOVERY_REQUIRED');
  for(const folder of folders){
   if(!folder.isFile()||!folder.name.endsWith('.json')||!UUID.test(folder.name.slice(0,-5)))throw fail('RECOVERY_REQUIRED');
   const markerPath=path.join(pendingDirectory,folder.name),markerSource=await readSource(markerPath,4096),marker=parse(markerSource.bytes);
   if(!keys(marker,['version','id','journalSha256'])||marker.version!==1||marker.id!==folder.name.slice(0,-5)||typeof marker.journalSha256!=='string'||! /^[a-f0-9]{64}$/.test(marker.journalSha256))throw fail('RECOVERY_REQUIRED');
   const base=path.join(parent,marker.id);await checkedPath(base,{directory:true});
   const bytes=await readSource(path.join(base,'journal.json'),16384);if(!bytes||bytes.sha256!==marker.journalSha256)throw fail('RECOVERY_REQUIRED');const journal=parse(bytes.bytes);
   if(!keys(journal,['version','state','groups'])||journal.version!==1||journal.state!=='prepared'||!Array.isArray(journal.groups)||journal.groups.length<1||journal.groups.length>5||new Set(journal.groups.map(e=>e.key)).size!==journal.groups.length)throw fail('RECOVERY_REQUIRED');
   if(journal.groups.some(entry=>!keys(entry,['key','oldSha','newSha'])||!Object.hasOwn(GROUP_FILES,entry.key)||entry.oldSha!==null&&(typeof entry.oldSha!=='string'||! /^[a-f0-9]{64}$/.test(entry.oldSha))||typeof entry.newSha!=='string'||! /^[a-f0-9]{64}$/.test(entry.newSha)))throw fail('RECOVERY_REQUIRED');
   const complete=await readSource(path.join(base,'complete.json'),4096),failed=await readSource(path.join(base,'failed.json'),4096);
   if(complete||failed){const value=parse((complete||failed).bytes);if(complete&&failed||!keys(value,['version','state','journalSha256'])||value.version!==2||value.journalSha256!==bytes.sha256||value.state!==(complete?'complete':'rolled-back'))throw fail('RECOVERY_REQUIRED');await removePending(markerPath,markerSource.sha256);continue;}
   const entries=[];
   for(const entry of journal.groups){
    if(!keys(entry,['key','oldSha','newSha'])||!Object.hasOwn(GROUP_FILES,entry.key)||entry.oldSha!==null&&(typeof entry.oldSha!=='string'||! /^[a-f0-9]{64}$/.test(entry.oldSha))||typeof entry.newSha!=='string'||! /^[a-f0-9]{64}$/.test(entry.newSha))throw fail('RECOVERY_REQUIRED');
    const target=path.join(directory,GROUP_FILES[entry.key]),staged=path.join(base,entry.key+'.new.json'),moved=path.join(base,entry.key+'.moved.json');await finishOwnLink(staged,target,entry.newSha);
    const current=await readSource(target,originalLimit(entry.key)),original=await readSource(path.join(base,entry.key+'.original.json'),originalLimit(entry.key)),oldMoved=await readSource(moved,originalLimit(entry.key));
    if(entry.oldSha!==null&&original?.sha256!==entry.oldSha||oldMoved&&oldMoved.sha256!==entry.oldSha||current&&![entry.newSha,entry.oldSha].includes(current.sha256)||!current&&entry.oldSha!==null&&!oldMoved)throw fail('RECOVERY_REQUIRED');
    entries.push({...entry,target,moved,current,oldMoved});
   }
   for(const entry of entries.reverse()){
    const current=await readSource(entry.target,originalLimit(entry.key));if((current?.identity??null)!==(entry.current?.identity??null))throw fail('RECOVERY_REQUIRED');
    if(current?.sha256===entry.newSha){await fs.rename(entry.target,path.join(base,entry.key+'.recovered-'+crypto.randomUUID()+'.json'));}
    const remaining=await readSource(entry.target,originalLimit(entry.key));
    if(entry.oldSha!==null&&!remaining){if(!entry.oldMoved)throw fail('RECOVERY_REQUIRED');await fs.link(entry.moved,entry.target);await fs.unlink(entry.moved);if((await readSource(entry.target,originalLimit(entry.key)))?.sha256!==entry.oldSha)throw fail('RECOVERY_REQUIRED');}
   }
   await writeNew(path.join(base,'failed.json'),JSON.stringify({version:2,state:'rolled-back',journalSha256:bytes.sha256})+'\n');await removePending(markerPath,markerSource.sha256);
  }
  if(oldLock){await assertSource(lockPath,oldLock);await fs.unlink(lockPath);}
 }
 await recoverPending();
 return {exportDocument,previewBytes,previewFile,status,assertPreview,cancel,apply,validateDocument:document,recoverPending};
}
module.exports={MAX_BYTES,GROUP_FILES,WIDGETS,fail,checkedPath,readSource,createConfigBackup};
