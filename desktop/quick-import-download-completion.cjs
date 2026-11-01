'use strict';
const {randomUUID}=require('node:crypto');
const {endpointValid}=require('../download');

// This helper is only called by completed main-process downloads. There is no
// renderer channel accepting a path, and it never creates/opens a Companion.
function createQuickImportDownloadCompletion({getHost,isAvailable,newId=randomUUID}){
 return function completed({endpoint,result,authorized=false}){
  if(authorized!==true||!isAvailable()||!result||typeof result.destination!=='string'||!result.destination)return false;
  const native=typeof endpoint==='string'&&endpointValid(endpoint)&&!endpoint.includes('/admin/');
  const external=typeof endpoint==='string'&&/^enchor:[a-f0-9]{32}$/.test(endpoint)&&result.format==='folder';
  if(!native&&!external)return false;
  const host=getHost();if(typeof host?.acceptDownloadedChart!=='function')return false;
  try{
   const title=typeof result.folderName==='string'?result.folderName.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,'').trim().slice(0,200):'';
   Promise.resolve(host.acceptDownloadedChart({id:newId(),destination:result.destination,...(title?{title}:{})})).catch(()=>{});
   return true;
  }catch{return false;}
 };
}
module.exports={createQuickImportDownloadCompletion};
