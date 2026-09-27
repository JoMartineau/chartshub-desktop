'use strict';
// Main-process download state survives renderer navigation and card reconstruction.
function createDownloadState(publish=()=>{}){
 const items=new Map();let operation=null,revision=0,sequence=0;
 const snapshot=()=>({revision,operation:operation?{...operation,endpoints:[...operation.endpoints]}:null,items:Array.from(items.values(),item=>({...item}))});
 const emit=()=>{revision++;publish(snapshot());};
 const percent=value=>Number.isFinite(value)?Math.max(0,Math.min(100,Math.floor(value))):0;
 return {snapshot,
  begin(endpoints,type){operation={id:++sequence,type,active:true,percent:0,message:'Préparation du téléchargement…',endpoints:[...endpoints]};for(const endpoint of endpoints)items.set(endpoint,{endpoint,status:'queued',percent:0,message:'En attente…'});emit();},
  progress(data){if(!operation?.active)return;const endpoint=data.endpoint||operation.endpoints[0];if(!operation.endpoints.includes(endpoint))return;
   const status=['queued','downloading','complete','error','cancelled'].includes(data.state)?data.state:'downloading';
   items.set(endpoint,{...items.get(endpoint),endpoint,status,percent:percent(data.itemPercent??data.percent),message:String(data.itemMessage??data.message??''),...(data.error?{error:String(data.error)}:{}),...(data.folderName?{folderName:String(data.folderName)}:{})});
   operation.percent=percent(data.percent);operation.message=String(data.message||operation.message);emit();
  },
  finish(result={}){if(!operation)return;
   const results=operation.type==='batch'?(result.results||[]):[{endpoint:operation.endpoints[0],...result}];
   for(const entry of results){if(!operation.endpoints.includes(entry.endpoint))continue;const prior=items.get(entry.endpoint);items.set(entry.endpoint,{...prior,status:entry.ok?'complete':entry.cancelled||result.cancelled?'cancelled':'error',percent:entry.ok?100:prior.percent,...(entry.folderName?{folderName:String(entry.folderName)}:{}),...(entry.error?{error:String(entry.error)}:{})});}
   for(const endpoint of operation.endpoints){const item=items.get(endpoint);if(['queued','downloading'].includes(item.status))items.set(endpoint,{...item,status:result.cancelled?'cancelled':'error',error:result.error||'Téléchargement interrompu.'});}
   const complete=operation.endpoints.filter(endpoint=>items.get(endpoint).status==='complete').length;
   operation={...operation,active:false,percent:result.ok?100:operation.percent,complete,total:operation.endpoints.length,cancelled:!!result.cancelled,error:result.error||'',message:result.error||`${complete}/${operation.endpoints.length} charts téléchargés.`};emit();
  }
 };
}
module.exports={createDownloadState};
