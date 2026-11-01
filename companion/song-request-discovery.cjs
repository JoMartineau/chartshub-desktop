'use strict';
const {randomUUID}=require('node:crypto');
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PLATFORMS=['twitch','tiktok','youtube','website','kick'];
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max):'';
const fail=code=>Object.assign(Error(code),{code});

// Missing requests remain a separate, local session inbox. Capturing a request
// performs no catalogue search, download, playback or network operation.
function createSongRequestDiscovery({getContext,receive,searchInstalled,onChange=()=>{},now=Date.now,newId=randomUUID}={}){
 if(typeof getContext!=='function'||typeof receive!=='function')throw TypeError('Discovery callbacks required');
 let generation=0,revision=0,scope=null,items=[];const seen=new Map();
 const context=()=>{try{const c=getContext();return c?.active===true&&HEX.test(c.rootKey)&&Number.isSafeInteger(c.lifecycle)?c:null;}catch{return null;}};
 function update(){
  const c=context(),key=c?`${c.rootKey}:${c.lifecycle}`:null;
  if(key!==scope){generation++;scope=key;items=[];seen.clear();revision++;notify();}
  return c;
 }
 const current=(c,ticket)=>{const live=context();return ticket===generation&&live&&live.rootKey===c.rootKey&&live.lifecycle===c.lifecycle;};
 const publicItem=item=>({id:item.id,platform:item.source.platform,viewerName:item.source.viewerName,query:item.query,createdAt:item.createdAt,state:item.state,error:item.error??null});
 const status=()=>{update();return{revision,items:items.map(publicItem),limit:20};};
 function notify(){try{onChange(status());}catch{}}
 function changed(){revision++;notify();}
 function capture(input){
  const c=update();if(!c||!input||!PLATFORMS.includes(input.platform))return false;
  if(typeof input.eventId!=='string'||!input.eventId||input.eventId.length>256||typeof input.viewerId!=='string'||!input.viewerId||input.viewerId.length>256)return false;
  const viewerName=clean(input.viewerName,80),query=clean(input.query,200);if(!viewerName||!query)return false;
  const key=JSON.stringify([input.platform,input.eventId]);if(seen.has(key))return false;
  const stamp=now();if(!Number.isSafeInteger(stamp)||stamp<0)return false;
  if(items.length>=20){const index=items.findIndex(item=>item.state!=='confirming');if(index<0)return false;items.splice(index,1);}
  const item={id:newId(),source:{platform:input.platform,eventId:input.eventId,viewerId:input.viewerId,viewerName},query,createdAt:stamp,state:'missing',attempts:0};
  if(!UUID.test(item.id))return false;
  items.push(item);seen.set(key,stamp);while(seen.size>200)seen.delete(seen.keys().next().value);changed();return true;
 }
 function selected(id){const c=update(),item=items.find(value=>value.id===id);if(!c||!item)throw fail('DISCOVERY_UNAVAILABLE');return{c,item,ticket:generation};}
 function search(id){const {item}=selected(id);if(item.state==='confirming')throw fail('DISCOVERY_BUSY');item.state='searching';item.error=null;changed();return{query:item.query};}
 function dismiss(id){const {item}=selected(id);if(item.state==='confirming')throw fail('DISCOVERY_BUSY');items=items.filter(value=>value!==item);changed();return status();}
 async function matches(id){
  const {c,item,ticket}=selected(id);if(typeof searchInstalled!=='function')throw fail('DISCOVERY_UNAVAILABLE');
  const result=await searchInstalled(item.query);if(!current(c,ticket))throw fail('DISCOVERY_UNAVAILABLE');
  if(result?.ok!==true||!Array.isArray(result.items))return{items:[],total:0};
  const values=result.items.filter(value=>HEX.test(value?.id)).slice(0,10).map(value=>({id:value.id,title:clean(value.title,512),artist:clean(value.artist,512),charter:clean(value.charter,512)}));
  return{items:values,total:Number.isSafeInteger(result.total)?result.total:values.length};
 }
 async function confirm(id,songId){
  if(!HEX.test(songId))throw fail('DISCOVERY_INVALID');
  const {c,item,ticket}=selected(id);if(item.state==='confirming'||item.state==='queued')throw fail('DISCOVERY_BUSY');
  item.state='confirming';item.error=null;changed();
  let result;
  try{result=await receive({...item.source,eventId:'discovery:'+item.id+':'+(++item.attempts),songId},{isCurrent:()=>Boolean(current(c,ticket))});}
  catch{result={ok:false,code:'library_unavailable'};}
  if(!current(c,ticket))throw fail('DISCOVERY_UNAVAILABLE');
  item.state=result?.ok===true?'queued':'missing';
  item.error=result?.ok===true?null:['disabled','ambiguous','not_found','song_unavailable','library_changed','library_unavailable','metadata_unknown','duration_limit','instrument_unavailable','difficulty_unavailable','duplicate_vote','cooldown','viewer_limit','queue_full','rate_limited'].includes(result?.code)?result.code:'unavailable';
  changed();return{ok:result?.ok===true,code:item.error};
 }
 function clear(){generation++;scope=null;items=[];seen.clear();changed();}
 return{status,capture,search,dismiss,matches,confirm,update,clear};
}
module.exports={createSongRequestDiscovery};
