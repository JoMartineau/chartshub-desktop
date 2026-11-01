import{paintControl,paintTrail}from'./input-viewer-paint.js';
import{updateTrails,trailGeometry}from'./input-viewer-model.js';
// This renderer has no input API, device enumeration or editable configuration.
// It consumes only the director's visual projection through a read-only bridge
// or the token-protected local HTTP snapshot used by an OBS Browser Source.
const canvas=document.getElementById('output'),ctx=canvas.getContext('2d'),api=window.ChartsHubInputViewerOutput;
if(api)document.body.classList.add('game-output');
if(api?.language==='en'){document.documentElement.lang='en';document.getElementById('position-handle').textContent='⠿ Move widget · Lock it from Companion';}
let state=null,previous={},trails=[],lastReply=0,stopped=false,configBytes='',frame=null,timer=null;
function accept(value){
 if(!value||value.version!==1||!['running','stopped'].includes(value.phase)||!Number.isSafeInteger(value.revision)||(value.config!==null&&(!Array.isArray(value.config.controls)||value.config.controls.length>24)))throw Error('Invalid display snapshot');
 const bytes=JSON.stringify(value.config);if(bytes!==configBytes){configBytes=bytes;previous={};trails=[];}
 state=value;lastReply=performance.now();document.body.classList.toggle('positioning',!!api&&value.positioning===true);
 if(value.phase!=='running'){previous={};trails=[];}
}
async function poll(){
 if(stopped)return;
 try{if(api){const value=await api.snapshot();if(!value?.ok)throw Error('Output unavailable');accept(value.state);}else{const url=new URL('../input-viewer-state',import.meta.url);url.search=location.search;const reply=await fetch(url,{cache:'no-store',credentials:'omit'});if(!reply.ok)throw Error('Output unavailable');accept(await reply.json());}}
 catch{state=null;previous={};trails=[];document.body.classList.remove('positioning');}
 if(!stopped)timer=setTimeout(poll,33);
}
function draw(now){
 const config=state?.config,fresh=now-lastReply<=600,pressed=fresh&&state?.phase==='running'?state.pressed:{};
 if(!config){ctx.clearRect(0,0,canvas.width,canvas.height);canvas.dataset.active='';canvas.dataset.trailCount='0';frame=requestAnimationFrame(draw);return;}
 const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1)),width=Math.round(config.width*dpr),height=Math.round(config.height*dpr);
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,config.width,config.height);ctx.fillStyle=config.background;ctx.fillRect(0,0,config.width,config.height);
 trails=updateTrails(trails,previous,pressed,config.controls,now,config.trails);previous=pressed;
 for(const trace of trails){const c=config.controls.find(item=>item.id===trace.id);if(!c?.visible)continue;const ghost=trailGeometry(c,trace,now,config.trails);if(ghost)paintTrail(ctx,c,ghost,config,trace,now);}
 for(const c of config.controls)if(c.visible)paintControl(ctx,c,pressed?.[c.id]===true,config);
 canvas.dataset.active=config.controls.filter(c=>c.visible&&pressed?.[c.id]===true).map(c=>c.id).join(' ');canvas.dataset.trailCount=String(trails.length);
 frame=requestAnimationFrame(draw);
}
window.addEventListener('beforeunload',()=>{stopped=true;clearTimeout(timer);cancelAnimationFrame(frame);});
void poll();frame=requestAnimationFrame(draw);
