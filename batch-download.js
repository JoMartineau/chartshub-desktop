'use strict';
const {endpointValid,downloadChart}=require('./download');
function batchValid(endpoints){return Array.isArray(endpoints)&&endpoints.length>0&&new Set(endpoints).size===endpoints.length&&endpoints.every(e=>endpointValid(e)&&!e.includes('/admin/'));}
async function downloadBatch({endpoints,directory,fetcher,signal,progress=()=>{},download=downloadChart,idleTimeoutMs}){
 if(!batchValid(endpoints))throw Error('Sélection de charts invalide.');
 const results=[];
 for(let i=0;i<endpoints.length;i++){
  if(signal.aborted)break;
  try{
   progress({endpoint:endpoints[i],state:'downloading',itemPercent:0,percent:Math.floor(i/endpoints.length*100),message:`${i+1}/${endpoints.length} · Préparation…`});
   const result=await download({endpoint:endpoints[i],directory,fetcher,signal,idleTimeoutMs,progress:p=>progress({...p,endpoint:endpoints[i],state:'downloading',itemPercent:p.percent,itemMessage:p.message,percent:Math.floor((i+p.percent/100)/endpoints.length*100),message:`${i+1}/${endpoints.length} · ${p.message}`})});
   results.push({endpoint:endpoints[i],ok:true,folderName:result.folderName,files:result.files});
   progress({endpoint:endpoints[i],state:'complete',itemPercent:100,percent:Math.floor((i+1)/endpoints.length*100),folderName:result.folderName,message:`${i+1}/${endpoints.length} · ${result.folderName}`});
  }catch(error){if(signal.aborted)break;results.push({endpoint:endpoints[i],ok:false,error:error.message});progress({endpoint:endpoints[i],state:'error',itemPercent:0,percent:Math.floor((i+1)/endpoints.length*100),error:error.message,message:`${i+1}/${endpoints.length} · ${error.message}`});}
 }
 return {ok:results.length===endpoints.length&&results.every(r=>r.ok),cancelled:signal.aborted,results,total:endpoints.length};
}
module.exports={batchValid,downloadBatch};
