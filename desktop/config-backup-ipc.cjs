'use strict';
const fs=require('node:fs'),path=require('node:path');
const {MAX_BYTES,checkedPath}=require('./config-backup.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const failure=code=>Object.assign(Error(code),{code});
function inside(file,parent){const relative=path.relative(parent,file);return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function summary(value){if(!value||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.sourceVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(value.sourceVersion)||!Array.isArray(value.groups)||value.groups.length>8||value.groups.some(g=>!g||!['overlay','profiles','panels','bloom','requests'].includes(g.key)||!Number.isSafeInteger(g.count)||g.count<0||g.count>10000))throw failure('BACKUP_UNAVAILABLE');return {id:value.id??null,createdAt:value.createdAt,sourceVersion:value.sourceVersion,groups:value.groups.map(({key,count})=>({key,count}))};}
function plainPayload(value,idRequired){if(!idRequired)return value===undefined||value===null||!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0;return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.id==='string'&&UUID.test(value.id);}
function createConfigBackupIpc({engine,getPanel=()=>null,dialog,protectedDirectories,beforeExport=async()=>null,beginApply,publish=()=>{},language=()=> 'en',now=()=>new Date()}={}){
 if(!engine||!dialog||typeof dialog.showSaveDialog!=='function'||typeof dialog.showOpenDialog!=='function'||typeof dialog.showMessageBox!=='function'||typeof beginApply!=='function'||!Array.isArray(protectedDirectories)||protectedDirectories.length<1||protectedDirectories.some(item=>typeof item!=='string'||!path.isAbsolute(item)))throw TypeError('Explicit backup dependencies and protected directories required');
 const protectedRoots=protectedDirectories.map(item=>path.resolve(item));let busy=false,error=null,disposed=false,generation=0;
 const tr=(fr,en)=>language()==='fr'?fr:en;
 function state(){let preview=null;try{const value=engine.status();preview=value.preview?summary(value.preview):null;}catch{error='BACKUP_UNAVAILABLE';}return {busy,preview,error};}
 function notify(){if(!disposed)try{publish(state());}catch{}}
 function current(ticket,guard){let permitted=false;try{permitted=guard()===true;}catch{}if(disposed||ticket!==generation||!permitted)throw failure('BACKUP_CANCELLED');}
 function owner(){const panel=getPanel();return panel&&(!panel.isDestroyed||!panel.isDestroyed())?panel:null;}
 function call(name,options){const panel=owner();return panel?dialog[name](panel,options):dialog[name](options);}
 async function allowed(file,{missing=false}={}){
  if(typeof file!=='string'||!file||file.includes('\0')||!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.json'||/[:\s.]$/.test(path.basename(file))||path.basename(file).includes(':'))throw failure('BACKUP_INVALID_FILE');
  const absolute=path.resolve(file);if(protectedRoots.some(parent=>inside(absolute,parent)))throw failure('BACKUP_PROTECTED_LOCATION');
  await checkedPath(path.dirname(absolute),{directory:true});await checkedPath(absolute,{missing});const parent=fs.realpathSync(path.dirname(absolute)),actual=path.join(parent,path.basename(absolute));for(const protectedRoot of protectedRoots){const real=fs.realpathSync(protectedRoot);if(inside(actual,real))throw failure('BACKUP_PROTECTED_LOCATION');}const parentInfo=fs.lstatSync(path.dirname(absolute));return {file:absolute,parent,dev:parentInfo.dev,ino:parentInfo.ino};
 }
 async function withStableSettings(ticket,work,guard){const release=await beforeExport();try{current(ticket,guard);return await work();}finally{if(typeof release==='function')await release();}}
 function saveNew(selection,bytes){
  const file=selection.file,parent=fs.realpathSync(path.dirname(file)),parentInfo=fs.lstatSync(path.dirname(file));if(parent!==selection.parent||parentInfo.dev!==selection.dev||parentInfo.ino!==selection.ino)throw failure('BACKUP_INVALID_FILE');for(const protectedRoot of protectedRoots)if(inside(path.join(parent,path.basename(file)),fs.realpathSync(protectedRoot)))throw failure('BACKUP_PROTECTED_LOCATION');const expected=path.join(parent,path.basename(file));let fd;
  try{
   fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);const opened=fs.fstatSync(fd);
   if(!opened.isFile()||opened.nlink!==1||fs.realpathSync(file)!==expected)throw failure('BACKUP_INVALID_FILE');
   let at=0;while(at<bytes.length){const count=fs.writeSync(fd,bytes,at,bytes.length-at,at);if(!count)throw failure('BACKUP_SAVE_FAILED');at+=count;}fs.fsyncSync(fd);
   const after=fs.fstatSync(fd),named=fs.lstatSync(file);if(after.size!==bytes.length||named.nlink!==1||named.isSymbolicLink()||after.dev!==named.dev||after.ino!==named.ino||parent!==fs.realpathSync(path.dirname(file))||fs.realpathSync(file)!==expected)throw failure('BACKUP_SAVE_FAILED');
  }catch(reason){if(reason.code==='EEXIST')throw failure('BACKUP_FILE_EXISTS');throw reason;}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 async function invoke(action,payload,guard=()=>true){
  if(disposed)return {ok:false,error:'BACKUP_CANCELLED'};
  if(!['backup.export','backup.preview','backup.apply','backup.cancel'].includes(action)||!plainPayload(payload,['backup.apply','backup.cancel'].includes(action)))return {ok:false,error:'BACKUP_INVALID_COMMAND'};
  try{current(generation,guard);}catch{return {ok:false,error:'BACKUP_CANCELLED'};}
  if(busy)return {ok:false,error:'BACKUP_BUSY'};busy=true;error=null;const ticket=generation;notify();
  try{
   if(action==='backup.export'){
    const date=now().toISOString().replace(/[:.]/g,'-'),result=await call('showSaveDialog',{title:tr('Enregistrer ma configuration','Save my configuration'),defaultPath:'ChartsHub-configuration-'+date+'.json',filters:[{name:tr('Configuration ChartsHub','ChartsHub configuration'),extensions:['json']}]});current(ticket,guard);
    if(result.canceled||!result.filePath)return {ok:true,cancelled:true};const selection=await allowed(result.filePath,{missing:true});current(ticket,guard);
    await withStableSettings(ticket,async()=>{const document=await engine.exportDocument();current(ticket,guard);if(!Buffer.isBuffer(document.bytes)||document.bytes.length<2||document.bytes.length>MAX_BYTES)throw failure('BACKUP_UNAVAILABLE');summary(document.summary);saveNew(selection,document.bytes);},guard);return {ok:true,exported:true};
   }
   if(action==='backup.preview'){
    const result=await call('showOpenDialog',{title:tr('Choisir une sauvegarde de configuration','Choose a configuration backup'),properties:['openFile'],filters:[{name:tr('Configuration ChartsHub','ChartsHub configuration'),extensions:['json']}]});current(ticket,guard);
    if(result.canceled||!Array.isArray(result.filePaths)||result.filePaths.length!==1)return {ok:true,cancelled:true};const selection=await allowed(result.filePaths[0]);current(ticket,guard);
    const preview=await withStableSettings(ticket,async()=>summary(await engine.previewFile(selection.file)),guard);current(ticket,guard);if(!UUID.test(preview.id||''))throw failure('BACKUP_UNAVAILABLE');return {ok:true,preview};
   }
   const preview=state().preview;if(!preview||preview.id!==payload.id)throw failure('BACKUP_PREVIEW_EXPIRED');
   if(action==='backup.cancel'){await engine.cancel(payload.id);return {ok:true};}
   const result=await call('showMessageBox',{type:'question',title:tr('Restaurer ma configuration','Restore my configuration'),message:tr('Restaurer cette configuration visuelle et redémarrer ChartsHub ?','Restore this visual configuration and restart ChartsHub?'),detail:tr('Les catégories affichées remplaceront leurs réglages actuels.','The displayed categories will replace their current settings.'),buttons:[tr('Restaurer et redémarrer','Restore and restart'),tr('Annuler','Cancel')],defaultId:1,cancelId:1,noLink:true});current(ticket,guard);
   if(result.response!==0)return {ok:true,cancelled:true};const applied=await beginApply(payload.id);if(applied?.ok===false)throw failure('BACKUP_APPLY_FAILED');return {ok:true,restarting:true};
  }catch(reason){if(reason.code==='BACKUP_CANCELLED')return {ok:false,error:'BACKUP_CANCELLED'};error=/^BACKUP_[A-Z_]{1,80}$/.test(reason.code||'')?reason.code:'BACKUP_FAILED';notify();return {ok:false,error};}
  finally{busy=false;notify();}
 }
 return {getState:state,invoke,dispose(){disposed=true;generation++;}};
}
module.exports={createConfigBackupIpc};
