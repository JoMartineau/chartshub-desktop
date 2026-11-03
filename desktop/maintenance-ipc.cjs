'use strict';
const {trustedContentsSender}=require('../companion/security.cjs');
const STATE='chartshub-maintenance:state',COMMAND='chartshub-maintenance:command',CHANGED='chartshub-maintenance:changed';
const ACTIONS=['update.check','update.download','update.cancel','update.openRelease','update.install','update.rollback'];
function createMaintenanceIpc({ipcMain,updater,getContents,getOwner,isAvailable,dialog,beginInstall,language=()=> 'en'}={}){
 let disposed=false,confirming=false,backupModule=null;
 const trusted=event=>!disposed&&isAvailable()===true&&trustedContentsSender(event,getContents(),'index.html');
 const snapshot=()=>({updater:updater.snapshot(),backup:backupModule?.getState()??{busy:true,preview:null,error:null}});
 function publish(){const contents=getContents();if(!disposed&&isAvailable()&&contents&&!contents.isDestroyed?.()&&!contents.isLoading?.())contents.send(CHANGED,snapshot());}
 async function confirmInstall(isCurrent,kind='update'){
  const rollback=kind==='rollback',allowed=()=>rollback?updater.snapshot().canRollback:updater.snapshot().canInstall;
  if(disposed||confirming||!isCurrent()||!allowed())return {ok:false,error:'UPDATE_OPERATIONS_ACTIVE'};
  confirming=true;
  try{
   const owner=getOwner(),fr=language()==='fr';
   const answer=await dialog.showMessageBox(owner,{type:'question',buttons:fr?['Annuler',rollback?'Restaurer et redémarrer':'Installer et redémarrer']:['Cancel',rollback?'Restore and restart':'Install and restart'],defaultId:0,cancelId:0,noLink:true,
    message:rollback?(fr?'Revenir à la version '+updater.snapshot().previousVersion+' ?':'Restore version '+updater.snapshot().previousVersion+'?'):(fr?'Installer la nouvelle version de ChartsHub ?':'Install the new ChartsHub version?'),
    detail:fr?'ChartsHub va fermer normalement, installer les fichiers officiels vérifiés, puis redémarrer. Vos chansons et réglages sont conservés. L’ancienne application est sauvegardée.':'ChartsHub will close normally, install the verified official files, then restart. Songs and settings are preserved. The previous application is backed up.'});
   if(answer.response!==1)return {ok:true,cancelled:true};
   if(disposed||!isCurrent()||getOwner()!==owner||!allowed())return {ok:false,error:'UPDATE_OPERATIONS_ACTIVE'};
   await beginInstall(()=>!disposed&&isCurrent()&&getOwner()===owner,kind);
   return {ok:true,restarting:true};
  }finally{confirming=false;publish();}
 }
 ipcMain.handle(STATE,(event,payload)=>trusted(event)&&payload===undefined?snapshot():null);
 ipcMain.handle(COMMAND,async(event,action,payload)=>{
  if(!trusted(event)||confirming)return {ok:false,error:'UPDATE_UNAUTHORIZED'};
  if(['backup.export','backup.preview','backup.apply','backup.cancel'].includes(action)){
   if(!backupModule)return {ok:false,error:'BACKUP_UNAVAILABLE'};
   const result=await backupModule.invoke(action,payload,()=>trusted(event));publish();return result;
  }
  if(!ACTIONS.includes(action)||payload!==undefined)return {ok:false,error:'UPDATE_UNAUTHORIZED'};
  try{
   if(action==='update.install'||action==='update.rollback')return await confirmInstall(()=>trusted(event),action==='update.rollback'?'rollback':'update');
   const method={'update.check':'check','update.download':'download','update.cancel':'cancel','update.openRelease':'openRelease'}[action];
   await updater[method]();return {ok:true,state:snapshot()};
  }catch(error){return {ok:false,error:typeof error?.code==='string'&&/^UPDATE_[A-Z_]+$/.test(error.code)?error.code:'UPDATE_FAILED'};}
  finally{publish();}
 });
 return {snapshot,publish,confirmInstall,isConfirming:()=>confirming,setBackupModule:value=>{backupModule=value;publish();},dispose(){disposed=true;backupModule?.dispose();ipcMain.removeHandler(STATE);ipcMain.removeHandler(COMMAND);}};
}
module.exports={STATE,COMMAND,CHANGED,ACTIONS,createMaintenanceIpc};
