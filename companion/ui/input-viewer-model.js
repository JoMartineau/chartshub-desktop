export const STORAGE_KEY='chartshub:input-viewer-config-v1';
export const KEY_CODES=Object.freeze([...Array.from({length:26},(_,i)=>'Key'+String.fromCharCode(65+i)),...Array.from({length:10},(_,i)=>'Digit'+i),...Array.from({length:10},(_,i)=>'Numpad'+i),'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter','ShiftLeft','ShiftRight','ControlLeft','ControlRight']);
const copy=value=>JSON.parse(JSON.stringify(value));
const control=(id,label,color,x,y,key,shape='circle',width=78,height=78)=>({id,label,color,x,y,width,height,shape,visible:true,fontSize:16,mapping:{kind:'none',index:0,direction:1,threshold:.5,key}});
export function preset(mode='guitar',language='fr'){
 const drums=mode==='drums4'||mode==='drums5';
 const controls=drums?[
  ...['Rouge','Jaune','Bleu','Vert',...(mode==='drums5'?['Orange']:[])].map((name,i)=>control('pad'+i,name,['#ef485b','#f9cf48','#488fff','#3cda7f','#ff9d38'][i],70+i*140,128,['KeyA','KeyS','KeyD','KeyF','KeyG'][i])),
  ...['Jaune','Bleue','Verte'].map((name,i)=>control('cymbal'+i,'Cymbale '+name,['#f9cf48','#488fff','#3cda7f'][i],180+i*170,44,['KeyQ','KeyW','KeyE'][i],'rect',110,32)),
  control('kick','Grosse caisse','#e9eefa',330,238,'Space','rect',140,44),control('power','Star Power','#60edff',686,238,'ShiftLeft','diamond',58,58)
 ]:[...['Vert','Rouge','Jaune','Bleu','Orange'].map((name,i)=>control('fret'+i,name,['#38db77','#ef485b','#f9cf48','#488fff','#ff9d38'][i],40+i*112,140,['KeyA','KeyS','KeyD','KeyF','KeyG'][i])),control('up','Strum ↑','#d5def2',620,86,'ArrowUp','rect',72,50),control('down','Strum ↓','#d5def2',620,166,'ArrowDown','rect',72,50),control('power','Star Power','#60edff',718,142,'Space','diamond',60,60)];
 if(language==='en'){const names={'Vert':'Green','Rouge':'Red','Jaune':'Yellow','Bleu':'Blue','Orange':'Orange','Cymbale Jaune':'Yellow cymbal','Cymbale Bleue':'Blue cymbal','Cymbale Verte':'Green cymbal','Grosse caisse':'Kick'};for(const item of controls)item.label=names[item.label]||item.label;}
 return{version:1,mode:drums?mode:'guitar',source:'gamepad',width:800,height:320,background:'#00000000',bloom:16,showNames:true,deadzone:.2,trails:{enabled:true,durationMs:450,intensity:.55,length:90,speedPxPerSecond:200,thickness:100,direction:'up',fade:1.5},controls};
}
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const integer=(value,min,max)=>Number.isInteger(value)&&number(value,min,max);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function validateConfig(value){
 if(!exact(value,['version','mode','source','width','height','background','bloom','showNames','deadzone','trails','controls'])||value.version!==1||!['guitar','drums4','drums5'].includes(value.mode)||!['gamepad','keyboard'].includes(value.source)||!integer(value.width,320,1920)||!integer(value.height,120,1080)||!/^#[a-f0-9]{8}$/i.test(value.background)||!number(value.bloom,0,40)||typeof value.showNames!=='boolean'||!number(value.deadzone,0,.95))throw Error('Invalid viewer configuration');
 const t=value.trails;if(!exact(t,['enabled','durationMs','intensity','length','speedPxPerSecond','thickness','direction','fade'])||typeof t.enabled!=='boolean'||!integer(t.durationMs,50,3000)||!number(t.intensity,0,1)||!number(t.length,0,300)||!number(t.speedPxPerSecond,0,2000)||!number(t.thickness,1,100)||!['up','down','left','right'].includes(t.direction)||!number(t.fade,.2,4))throw Error('Invalid trails');
 const expected=preset(value.mode).controls.map(c=>c.id);if(!Array.isArray(value.controls)||value.controls.length!==expected.length)throw Error('Invalid controls');
 const ids=new Set();for(const c of value.controls){
  if(!exact(c,['id','label','color','x','y','width','height','shape','visible','fontSize','mapping'])||!expected.includes(c.id)||ids.has(c.id)||typeof c.label!=='string'||c.label.length>32||/[\x00-\x1f\x7f]/.test(c.label)||!/^#[a-f0-9]{6}$/i.test(c.color)||!number(c.x,0,value.width)||!number(c.y,0,value.height)||!number(c.width,12,value.width)||!number(c.height,12,value.height)||c.x+c.width>value.width||c.y+c.height>value.height||!['circle','rect','diamond'].includes(c.shape)||typeof c.visible!=='boolean'||!integer(c.fontSize,8,48))throw Error('Invalid control');ids.add(c.id);
  const m=c.mapping;if(!exact(m,['kind','index','direction','threshold','key'])||!['none','button','axis'].includes(m.kind)||!integer(m.index,0,m.kind==='axis'?15:63)||![1,-1].includes(m.direction)||!number(m.threshold,.05,1)||!KEY_CODES.includes(m.key))throw Error('Invalid mapping');
 }
 return copy(value);
}
export function readConfig(storage,language='fr'){try{const raw=storage?.getItem(STORAGE_KEY);if(raw&&raw.length<=16384)return validateConfig(JSON.parse(raw));}catch{}return preset('guitar',language);}
export function writeConfig(storage,value){const config=validateConfig(value),raw=JSON.stringify(config);if(raw.length>16384)throw Error('Configuration too large');storage?.setItem(STORAGE_KEY,raw);return config;}
export function sampleControls(config,{gamepad=null,keys=new Set(),focused=false}={}){
 return Object.fromEntries(config.controls.map(c=>{
  let pressed=false;
  if(c.visible&&config.source==='keyboard')pressed=focused&&keys.has(c.mapping.key);
  else if(c.visible&&gamepad?.connected===true){const m=c.mapping;
   if(m.kind==='button'){const b=gamepad.buttons?.[m.index];pressed=!!b&&(b.pressed===true||(number(b.value,0,1)&&b.value>=m.threshold));}
   if(m.kind==='axis'){const axis=gamepad.axes?.[m.index];pressed=number(axis,-1,1)&&axis*m.direction>=Math.max(config.deadzone,m.threshold);}
  }
  return[c.id,pressed];
 }));
}
export function updateTrails(trails,previous,next,controls,now,settings){
 const retained=settings.enabled?trails.filter(item=>now-item.at>=0&&now-item.at<settings.durationMs):[];
 if(settings.enabled)for(const c of controls)if(next[c.id]){
  const last=retained.findLast(item=>item.id===c.id);
  if(!previous[c.id]||!last||now-last.at>=1000/30)retained.push({id:c.id,at:now});
 }
 // Keep the configured lifetime even when every drum pad or fret is held.
 // Controls and duration are validated: at most ten controls and 3,000 ms.
 const limit=Math.min(920,controls.length*(Math.ceil(settings.durationMs/(1000/30))+2));
 return retained.slice(-limit);
}
export function trailGeometry(control,trace,now,settings){
 const age=(now-trace.at)/settings.durationMs;if(age<0||age>=1)return null;
 const vectors={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]},vector=vectors[settings.direction],distance=Math.min(settings.length,(now-trace.at)/1000*settings.speedPxPerSecond),scale=settings.thickness/100;
 return{...control,x:control.x+control.width*(1-scale)/2+vector[0]*distance,y:control.y+control.height*(1-scale)/2+vector[1]*distance,width:control.width*scale,height:control.height*scale,opacity:Math.pow(1-age,settings.fade)*settings.intensity};
}
export function learnGamepadMapping(gamepad,previous,threshold=.5,deadzone=.2){
 const levels=[];for(let index=0;index<64;index++){const b=gamepad?.connected===true?gamepad.buttons?.[index]:null;levels.push(!!b&&(b.pressed===true||(number(b.value,0,1)&&b.value>=threshold)));}
 for(let index=0;index<16;index++){const axis=gamepad?.connected===true?gamepad.axes?.[index]:null;for(const direction of [1,-1])levels.push(number(axis,-1,1)&&axis*direction>=Math.max(threshold,deadzone));}
 const rising=previous?levels.findIndex((value,index)=>value&&!previous[index]):-1;
 const mapping=rising<0?null:rising<64?{kind:'button',index:rising,direction:1}:{kind:'axis',index:Math.floor((rising-64)/2),direction:(rising-64)%2===0?1:-1};
 return{levels,mapping};
}
