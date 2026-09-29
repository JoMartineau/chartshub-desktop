'use strict';
// Main-process download state survives renderer navigation and card reconstruction.
function createDownloadState(publish=()=>{}){
 const items=new Map();let operation=null,revision=0,sequence=0;
 const snapshot=()=>({revision,operation:operation?{...operation,endpoints:[...operation.endpoints]}:null,items:Array.from(items.values(),item=>({...item}))});
 const emit=()=>{revision++;publish(snapshot());};
 const percent=value=>Number.isFinite(value)?Math.max(0,Math.min(100,Math.floor(value))):0;
 return {snapshot,
  clear(){items.clear();operation=null;emit();},
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
// Identity comes from the authenticated main-process request, never renderer data.
// Keep navigation reversible, but hide all history until the account is checked.
function createAccountBoundDownloads({readAccount,publish=()=>{},cancel=()=>{}}){
 let identity,account=null,visible=false,generation=0,epoch=0,revision=0,pending=null;
 const snapshot=()=>visible?{...state.snapshot(),revision}:{revision,operation:null,items:[]};
 const emit=()=>{revision++;publish(snapshot());};
 const state=createDownloadState(()=>{if(visible)emit();});
 const purge=()=>{epoch++;state.clear();cancel();};
 const invalidate=()=>{generation++;visible=false;account=null;emit();};
 async function refresh(){
  if(pending?.generation===generation)return pending.promise;
  const at=generation;visible=false;emit();
  const request={generation:at};
  request.promise=(async()=>{
   let user,key;
   try{
    user=await readAccount();
    if(user===null)key='guest';
    else{
     if(!user||typeof user.id!=='string'||!user.id||user.id.length>200)throw Error('Invalid account response');
     user={id:user.id,emailVerified:user.emailVerified===true,staffRole:['moderator','administrator'].includes(user.staffRole)?user.staffRole:null};
     key=JSON.stringify(user);
    }
   }catch{
    if(at!==generation)return refresh();
    identity=undefined;account=null;visible=false;purge();emit();return {ok:false,user:null};
   }
   if(at!==generation)return refresh();
   if(identity!==undefined&&identity!==key)purge();
   identity=key;account=user;visible=true;emit();return {ok:true,user};
  })().finally(()=>{if(pending===request)pending=null;});
  pending=request;return request.promise;
 }
 return {snapshot,invalidate,refresh,
  begin(endpoints,type){if(!visible)throw Error('Le compte ne peut pas être vérifié. Réessayez.');state.begin(endpoints,type);return epoch;},
  progress(token,data){if(token!==epoch)return false;state.progress(data);return visible;},
  finish(token,result){if(token===epoch)state.finish(result);},
  current:token=>visible&&token===epoch,
  user:()=>visible?account:null
 };
}
module.exports={createDownloadState,createAccountBoundDownloads};
