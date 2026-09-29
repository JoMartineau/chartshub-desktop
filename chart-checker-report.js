'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function saveCheckerReport({payload,choose,authorized=()=>true}){
 if(!authorized()||typeof payload!=='string'||Buffer.byteLength(payload)>8*1024*1024)throw Error('Rapport non autorisé ou trop volumineux.');
 let data;try{data=JSON.parse(payload);}catch{throw Error('Rapport invalide.');}
 if(data.engine!=='scan-chart'||data.version!=='7.0.1'||!Array.isArray(data.reports)||data.reports.length>500)throw Error('Rapport invalide.');
 const choice=await choose();if(choice.canceled||!choice.filePath)return {ok:false,cancelled:true};
 if(!authorized())return {ok:false,cancelled:true};
 const target=path.resolve(choice.filePath);if(path.extname(target).toLowerCase()!=='.json')throw Error('Choisissez un fichier .json pour le rapport.');
 const previous=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(previous&&(!previous.isFile()||previous.isSymbolicLink()))throw Error('Choisissez un fichier ordinaire.');
 const temporary=path.join(path.dirname(target),'.chartshub-report-'+crypto.randomUUID()+'.tmp');
 try{await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});if(!authorized())return {ok:false,cancelled:true};await fs.rename(temporary,target);return {ok:true};}
 finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
module.exports={saveCheckerReport};
