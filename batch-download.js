'use strict';
const {endpointValid,downloadChart}=require('./download');
const {normalizeEnchorRequest,enchorIdentity,downloadEnchor}=require('./enchor-download');
function normalizeBatch(endpoints){
 if(!Array.isArray(endpoints)||!endpoints.length)throw Error('Sélection de charts invalide.');
 const seen=new Set();return endpoints.map(value=>{
  let item;if(typeof value==='string'){if(!endpointValid(value)||value.includes('/admin/'))throw Error('Sélection de charts invalide.');item={endpoint:value};}
  else{let request;try{request=normalizeEnchorRequest(value);}catch{throw Error('Sélection de charts invalide.');}item={endpoint:enchorIdentity(request.md5),request};}
  if(seen.has(item.endpoint))throw Error('Sélection de charts invalide.');seen.add(item.endpoint);return item;
 });
}
function batchValid(endpoints){try{normalizeBatch(endpoints);return true;}catch{return false;}}
async function downloadBatch({endpoints,directory,fetcher,signal,progress=()=>{},download=downloadChart,downloadExternal=downloadEnchor,idleTimeoutMs}){
 const items=normalizeBatch(endpoints);
 const results=[];let stopped;
 for(let i=0;i<items.length;i++){
  if(signal.aborted)break;
  const item=items[i];
  try{
   progress({endpoint:item.endpoint,state:'downloading',itemPercent:0,percent:Math.floor(i/items.length*100),message:`${i+1}/${items.length} · Préparation…`});
   const options={directory,fetcher,signal,idleTimeoutMs,progress:p=>progress({...p,endpoint:item.endpoint,state:'downloading',itemPercent:p.percent,itemMessage:p.message,percent:Math.floor((i+p.percent/100)/items.length*100),message:`${i+1}/${items.length} · ${p.message}`})};
   const result=await(item.request?downloadExternal({...options,request:item.request}):download({...options,endpoint:item.endpoint}));
   results.push({endpoint:item.endpoint,ok:true,folderName:result.folderName,files:result.files,...(item.request?{fileName:result.fileName,format:'sng'}:{})});
   progress({endpoint:item.endpoint,state:'complete',itemPercent:100,percent:Math.floor((i+1)/items.length*100),folderName:result.folderName,message:`${i+1}/${items.length} · ${result.folderName}`});
  }catch(error){if(signal.aborted)break;results.push({endpoint:item.endpoint,ok:false,error:error.message});progress({endpoint:item.endpoint,state:'error',itemPercent:0,percent:Math.floor((i+1)/items.length*100),error:error.message,message:`${i+1}/${items.length} · ${error.message}`});if(item.request&&['ENCHOR_DOWNLOAD_ACCESS_DENIED','ENCHOR_DOWNLOAD_RATE_LIMITED'].includes(error.code)){stopped=error;break;}}
 }
 return {ok:results.length===items.length&&results.every(r=>r.ok),cancelled:signal.aborted,results,total:items.length,...(stopped?{error:stopped.message,code:stopped.code,...(stopped.retryAfterSeconds?{retryAfterSeconds:stopped.retryAfterSeconds}:{})}:{})};
}
module.exports={batchValid,normalizeBatch,downloadBatch};
