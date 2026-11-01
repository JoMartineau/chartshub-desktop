'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {defaultSettings,validateSettings}=require('./drum-vst-model.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=()=>Object.assign(Error('Drum preferences could not be saved; the previous file is preserved.'),{code:'DRUM_PREFERENCES'});
async function plainDirectory(directory){
 let at=path.resolve(directory);for(;;){try{const s=await fs.lstat(at);if(!s.isDirectory()||s.isSymbolicLink())throw failure();}catch(error){if(error.code!=='ENOENT')throw error;}const next=path.dirname(at);if(next===at)break;at=next;}
}
async function fileBytes(file){try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536)throw failure();const bytes=await fs.readFile(file);if(bytes.length>65536)throw failure();return bytes;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function document(value){if(!value||value.version!==1||Object.keys(value).sort().join(',')!=='pluginPath,settings,version'||!(value.pluginPath===null||typeof value.pluginPath==='string'&&path.isAbsolute(value.pluginPath)&&value.pluginPath.length<=2048&&!/[\x00-\x1f]/.test(value.pluginPath)))throw failure();return{version:1,pluginPath:value.pluginPath,settings:validateSettings(value.settings)};}
function createDrumVstPreferences({dataDirectory}){
 if(!path.isAbsolute(dataDirectory))throw failure();const file=path.join(dataDirectory,'drum-vst-settings.json');let digest=null,canWrite=true,tail=Promise.resolve(),value={version:1,pluginPath:null,settings:defaultSettings()},loaded=false;
 async function load(){try{await plainDirectory(dataDirectory);const bytes=await fileBytes(file);digest=bytes?hash(bytes):null;if(bytes)value=document(JSON.parse(bytes));loaded=true;}catch{canWrite=false;loaded=true;}return{...structuredClone(value),canWrite};}
 function save(next){const candidate=document(next);const task=tail.then(async()=>{if(!loaded||!canWrite)throw failure();await plainDirectory(dataDirectory);await fs.mkdir(dataDirectory,{recursive:true});await plainDirectory(dataDirectory);const previous=await fileBytes(file);if((previous?hash(previous):null)!==digest){canWrite=false;throw failure();}const temporary=file+'.'+randomUUID()+'.tmp',bytes=Buffer.from(JSON.stringify(candidate,null,2)+'\n');let own=false;try{const handle=await fs.open(temporary,'wx',0o600);own=true;try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}const current=await fileBytes(file);if((current?hash(current):null)!==digest){canWrite=false;throw failure();}await fs.rename(temporary,file);own=false;digest=hash(bytes);value=candidate;}finally{if(own)await fs.unlink(temporary).catch(()=>{});}});tail=task.catch(()=>{});return task;}
 return{load,save,flush:()=>tail,status:()=>({...structuredClone(value),canWrite})};
}
module.exports={createDrumVstPreferences};
