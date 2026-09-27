'use strict';
// Bound inactivity, not the duration of a healthy chart or a large batch.
function idleTransfer(parent,timeoutMs=60000){
 const controller=new AbortController();let timer;
 const abort=()=>controller.abort(parent.reason);
 if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
 const touch=(delay=timeoutMs)=>{clearTimeout(timer);if(!controller.signal.aborted)timer=setTimeout(()=>controller.abort(new Error('Téléchargement interrompu : aucune donnée reçue. Réessayez la chart.')),delay);};
 const interrupted=new Promise((_,reject)=>{const fail=()=>reject(controller.signal.reason||new Error('Téléchargement annulé.'));if(controller.signal.aborted)fail();else controller.signal.addEventListener('abort',fail,{once:true});});
 interrupted.catch(()=>{});touch();
 return {signal:controller.signal,touch,wait:promise=>Promise.race([promise,interrupted]),close(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
module.exports={idleTransfer};
