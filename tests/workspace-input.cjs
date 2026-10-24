'use strict';
// Test input adapter: reveal existing Companion content through its real navigation.
// Floating widgets have no workspace navigation and are left untouched.
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function revealWorkspace(target,selector,{timeoutMs=10000}={}){
 if(!target?.webContents||typeof selector!=='string'||!selector)throw Error('Workspace input requires a window and selector');
 const web=target.webContents,start=Date.now();let state;
 const execute=async code=>{let timer;try{return await Promise.race([web.executeJavaScript(code),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Workspace input renderer did not finish')),timeoutMs);})]);}finally{clearTimeout(timer);}};
 do{
  state=await execute(`(()=>{
   const nav=document.querySelector('#companion-workspace-nav');if(!nav)return {standalone:true};
   const node=document.querySelector(${JSON.stringify(selector)});if(!node)return {waiting:true};
   const section=node.closest('[data-companion-workspaces]');if(!section)return {standalone:true};
   const allowed=section.dataset.companionWorkspaces.split(/\\s+/).filter(Boolean),root=section.closest('#companion-app'),active=root?.dataset.workspace;
   return {allowed,active,ready:allowed.includes(active)&&!node.closest('.workspace-inactive,[inert]')};
  })()`);
  if(state.standalone||state.ready)return false;
  if(!state.waiting)break;
  await delay(25);
 }while(Date.now()-start<timeoutMs);
 if(state.waiting)throw Error('Workspace target did not appear: '+selector);
 const workspace=state.allowed[0];if(!workspace)throw Error('Workspace target has no destination: '+selector);
 const button='#companion-workspace-nav [data-companion-workspace="'+workspace+'"]';
 const point=await execute(`(async()=>{
  const n=document.querySelector(${JSON.stringify(button)});if(!n||n.disabled)throw Error('Workspace navigation unavailable');
  n.scrollIntoView({block:'center',inline:'center',behavior:'instant'});await new Promise(r=>{let done=false;const finish=()=>{if(!done){done=true;r();}};requestAnimationFrame(()=>requestAnimationFrame(finish));setTimeout(finish,80);});
  const rect=n.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)},hit=document.elementFromPoint(point.x,point.y);
  if(!rect.width||!rect.height||point.x<0||point.y<0||point.x>=innerWidth||point.y>=innerHeight||!hit||!(n===hit||n.contains(hit)))throw Error('Workspace navigation is hidden or covered');return point;
 })()`);
 if(target.isVisible?.())target.focus?.();web.focus();
 for(const type of ['mouseMove','mouseDown','mouseUp'])web.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
 do{
  if(await execute(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return document.querySelector('#companion-app')?.dataset.workspace===${JSON.stringify(workspace)}&&!!n&&!n.closest('.workspace-inactive,[inert]');})()`))return true;
  await delay(25);
 }while(Date.now()-start<timeoutMs);
 throw Error('Workspace navigation did not reveal '+selector);
}
module.exports={revealWorkspace};
