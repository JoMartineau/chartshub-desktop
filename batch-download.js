'use strict';
const {endpointValid,downloadChart}=require('./download');
function batchValid(endpoints){return Array.isArray(endpoints)&&endpoints.length>0&&new Set(endpoints).size===endpoints.length&&endpoints.every(e=>endpointValid(e)&&!e.includes('/admin/'));}
async function downloadBatch({endpoints,directory,fetcher,signal,progress=()=>{},download=downloadChart}){
 if(!batchValid(endpoints))throw Error('Sélection de charts invalide.');
 const results=[];
 for(let i=0;i<endpoints.length;i++){
  if(signal.aborted)break;
  try{
   const result=await download({endpoint:endpoints[i],directory,fetcher,signal,progress:p=>progress({...p,percent:Math.floor((i+p.percent/100)/endpoints.length*100),message:`${i+1}/${endpoints.length} · ${p.message}`})});
   results.push({endpoint:endpoints[i],ok:true,folderName:result.folderName,files:result.files});
  }catch(error){if(signal.aborted)break;results.push({endpoint:endpoints[i],ok:false,error:error.message});}
 }
 return {ok:results.length===endpoints.length&&results.every(r=>r.ok),cancelled:signal.aborted,results,total:endpoints.length};
}
module.exports={batchValid,downloadBatch};
