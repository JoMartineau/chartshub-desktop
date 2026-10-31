import{preset,readConfig,writeConfig,validateConfig,sampleControls,updateTrails,trailGeometry,learnGamepadMapping,KEY_CODES}from'./input-viewer-model.js';
const api=window.ChartsHubInputViewer,$=id=>document.getElementById(id),canvas=$('viewer'),ctx=canvas.getContext('2d'),en=api?.language==='en',tr=(fr,english)=>en?english:fr;
document.documentElement.lang=en?'en':'fr';
const translations={'Démarrer':'Start','Arrêter':'Stop','Masquer les réglages':'Hide settings','Guitare · 5 frettes':'Guitar · 5 frets','Batterie · 4 pads':'Drums · 4 pads','Batterie · 5 pads':'Drums · 5 pads','Rétablir ce preset':'Reset this preset','Manette / guitare compatible':'Compatible gamepad / guitar','Clavier · fenêtre active':'Keyboard · focused window','Manette':'Gamepad','Démarrer puis choisir':'Start, then choose','Composition et apparence':'Layout and appearance','Largeur':'Width','Hauteur':'Height','Afficher les noms':'Show labels','Zone morte des axes':'Axis dead zone','Élément et affectation':'Element and mapping','Élément':'Element','Nom':'Label','Couleur':'Color','Forme':'Shape','Cercle':'Circle','Rectangle':'Rectangle','Losange':'Diamond','Police':'Font size','Entrée manette':'Gamepad input','Non assignée':'Unassigned','Bouton':'Button','Axe':'Axis','Index (à partir de 0)':'Index (starts at 0)','Sens de l’axe':'Axis direction','Positif':'Positive','Négatif':'Negative','Seuil':'Threshold','Touche':'Key','Attribuer une touche':'Assign a key','Traînées':'Trails','Activer':'Enable','Durée (ms)':'Duration (ms)','Opacité / intensité':'Opacity / intensity','Longueur maximale (px)':'Maximum length (px)','Vitesse (px/s)':'Speed (px/s)','Épaisseur (%)':'Thickness (%)','Direction':'Direction','Haut':'Up','Bas':'Down','Gauche':'Left','Droite':'Right','Fondu':'Fade'};
if(en){const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=walk.nextNode()){const text=n.textContent.trim();if(translations[text])n.textContent=n.textContent.replace(text,translations[text]);}}
$('privacy').textContent=tr('Manette compatible Gamepad API ou clavier dans cette fenêtre active uniquement. Aucun accès au jeu, aucune mesure Accuracy. Dans OBS : Capture de fenêtre « ChartsHub — Input Viewer ».','Gamepad API compatible controllers, or keyboard only while this window is focused. No game access or Accuracy measurements. In OBS: Window Capture “ChartsHub — Input Viewer”.');
$('mapping-help').textContent=tr('Démarrez, choisissez la manette puis « Associer cette entrée » : relâchez et appuyez sur le bouton ou axe souhaité. Les index restent modifiables. Les guitares USB non exposées par Gamepad API ne sont pas prises en charge.','Start, choose a controller, then “Map this input”: release and press the desired button or axis. Indices remain editable. USB guitars not exposed by the Gamepad API are unsupported.');
let storage;try{storage=window.localStorage;}catch{}
let config=readConfig(storage,en?'en':'fr'),selected=config.controls[0].id,running=false,frame=null,keys=new Set(),pressed={},trails=[],selectedDevice=null,deviceIdentity=null,listSignature='',learning=false,drag=null,disposed=false;
const status=(fr,english)=>{$('status').textContent=tr(fr,english);};
const fieldIds=['source','width','height','background','bloom','names','deadzone','visible','label','color','shape','font','x','y','pad-width','pad-height','kind','index','direction','threshold','key','trails','duration','intensity','length','speed','thickness','trail-direction','fade'];
function option(parent,value,label){const node=document.createElement('option');node.value=value;node.textContent=label;parent.append(node);return node;}
for(const code of KEY_CODES)option($('key'),code,code);
function form(){
 const c=config.controls.find(value=>value.id===selected)||config.controls[0];selected=c.id;
 $('preset').value=config.mode;$('source').value=config.source;$('element').replaceChildren();for(const item of config.controls)option($('element'),item.id,item.label||item.id);$('element').value=selected;
 for(const[id,value]of Object.entries({width:config.width,height:config.height,background:config.background,bloom:config.bloom,deadzone:config.deadzone,label:c.label,color:c.color,shape:c.shape,font:c.fontSize,x:c.x,y:c.y,'pad-width':c.width,'pad-height':c.height,kind:c.mapping.kind,index:c.mapping.index,direction:c.mapping.direction,threshold:c.mapping.threshold,key:c.mapping.key,duration:config.trails.durationMs,intensity:config.trails.intensity,length:config.trails.length,speed:config.trails.speedPxPerSecond,thickness:config.trails.thickness,'trail-direction':config.trails.direction,fade:config.trails.fade}))$(id).value=String(value);
 $('names').checked=config.showNames;$('visible').checked=c.visible;$('trails').checked=config.trails.enabled;$('index').max=c.mapping.kind==='axis'?'15':'63';
 $('device').disabled=config.source!=='gamepad'||!running;
 $('learn').textContent=tr('Associer cette entrée','Map this input');
}
function shape(c,dx=0,dy=0){
 const x=c.x+dx,y=c.y+dy;ctx.beginPath();
 if(c.shape==='circle')ctx.ellipse(x+c.width/2,y+c.height/2,c.width/2,c.height/2,0,0,Math.PI*2);
 else if(c.shape==='diamond'){ctx.moveTo(x+c.width/2,y);ctx.lineTo(x+c.width,y+c.height/2);ctx.lineTo(x+c.width/2,y+c.height);ctx.lineTo(x,y+c.height/2);ctx.closePath();}
 else ctx.roundRect(x,y,c.width,c.height,Math.min(10,c.height/4));
}
function draw(now=performance.now()){
 const active=config.controls.filter(c=>pressed[c.id]===true).map(c=>c.id).join(' ');if(canvas.dataset.active!==active)canvas.dataset.active=active;
 const count=String(trails.length);if(canvas.dataset.trailCount!==count)canvas.dataset.trailCount=count;
 const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
 const pixelWidth=Math.round(config.width*dpr),pixelHeight=Math.round(config.height*dpr);if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
 canvas.style.width='min(100%, '+(config.width/config.height*430)+'px)';canvas.style.marginInline='auto';canvas.style.aspectRatio=config.width+'/'+config.height;ctx.setTransform(pixelWidth/config.width,0,0,pixelHeight/config.height,0,0);ctx.clearRect(0,0,config.width,config.height);ctx.fillStyle=config.background;ctx.fillRect(0,0,config.width,config.height);
 for(const trace of trails){const c=config.controls.find(item=>item.id===trace.id);if(!c?.visible)continue;const ghost=trailGeometry(c,trace,now,config.trails);if(!ghost)continue;ctx.save();ctx.globalAlpha=ghost.opacity;ctx.fillStyle=c.color;ctx.shadowColor=c.color;ctx.shadowBlur=config.bloom;shape(ghost);ctx.fill();ctx.restore();}
 for(const c of config.controls){if(!c.visible)continue;ctx.save();const down=pressed[c.id]===true;ctx.fillStyle=down?c.color:'#101c2bba';ctx.strokeStyle=c.color;ctx.lineWidth=down?4:2;ctx.shadowColor=c.color;ctx.shadowBlur=down?config.bloom:0;shape(c);ctx.fill();ctx.stroke();ctx.shadowBlur=0;if(config.showNames){ctx.fillStyle=down?'#08101a':'#edf4ff';ctx.font='600 '+c.fontSize+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(c.label,c.x+c.width/2,c.y+c.height/2,Math.max(5,c.width-8));}if(drag?.id===c.id){ctx.strokeStyle='#ffffff';ctx.setLineDash([4,4]);ctx.strokeRect(c.x-3,c.y-3,c.width+6,c.height+6);}ctx.restore();}
}
function clear(){keys.clear();pressed={};trails=[];draw();}
function save(next){try{config=writeConfig(storage,next);$('feedback').textContent=tr('Configuration enregistrée localement. Aucune entrée jouée n’est enregistrée.','Configuration saved locally. Played inputs are never recorded.');}catch{config=validateConfig(next);$('feedback').textContent=tr('Configuration appliquée pour cette fenêtre ; enregistrement local indisponible.','Configuration applied in this window; local saving unavailable.');}form();clear();}
function stopLocal(){running=false;learning=false;if(frame!==null)cancelAnimationFrame(frame);frame=null;selectedDevice=null;deviceIdentity=null;listSignature='';$('device').replaceChildren();option($('device'),'','—');$('device').disabled=true;$('start').disabled=false;$('stop').disabled=true;clear();status('Arrêté · aucune entrée lue','Stopped · no inputs read');}
function pads(){if(typeof navigator.getGamepads!=='function')throw Error('unavailable');const result=navigator.getGamepads();return Array.isArray(result)?result.slice(0,16).filter(value=>value&&value.connected===true&&Number.isInteger(value.index)&&value.index>=0&&value.index<16):[];}
function identity(pad){return pad.index+':'+String(pad.id||'').slice(0,512);}
function tick(now){
 if(!running||disposed)return;
 let pad=null;
 if(config.source==='gamepad'){
  try{const list=pads(),signature=JSON.stringify(list.map(p=>[identity(p),Math.min(64,p.buttons?.length||0),Math.min(16,p.axes?.length||0)]));
   if(signature!==listSignature){listSignature=signature;$('device').replaceChildren();option($('device'),'',tr('Choisir une manette','Choose a controller'));for(const p of list)option($('device'),String(p.index),tr('Manette ','Controller ')+(p.index+1)+' · '+Math.min(64,p.buttons?.length||0)+tr(' boutons · ',' buttons · ')+Math.min(16,p.axes?.length||0)+tr(' axes',' axes'));$('device').value=selectedDevice===null?'':String(selectedDevice);}
   pad=list.find(p=>p.index===selectedDevice&&identity(p)===deviceIdentity)||null;
   if(selectedDevice!==null&&!pad){selectedDevice=null;deviceIdentity=null;learning=false;$('device').value='';clear();}
   if(pad)status('Manette connectée · seules les affectations choisies s’allument','Controller connected · only configured mappings light up');else if(list.length)status('Choisissez une manette puis configurez ses boutons ou axes.','Choose a controller, then configure its buttons or axes.');else status('Aucune manette exposée. Appuyez sur un bouton ; certaines guitares USB ne sont pas compatibles.','No controller exposed. Press a controller button; some USB guitars are unsupported.');
  }catch{clear();status('Gamepad API indisponible ou accès refusé sur cet appareil.','Gamepad API unavailable or access denied on this device.');}
 }else status(document.hasFocus()?'Clavier local actif · aucune écoute hors de cette fenêtre':'Clavier suspendu · cliquez dans cette fenêtre',document.hasFocus()?'Local keyboard active · no listening outside this window':'Keyboard paused · focus this window');
 if(learning?.kind==='gamepad'){
  if(!pad||now-learning.at>15000){learning=false;$('feedback').textContent=tr('Association annulée. Choisissez une manette et réessayez.','Mapping cancelled. Choose a controller and retry.');}
  else{const learned=learnGamepadMapping(pad,learning.levels,learning.threshold,config.deadzone);learning.levels=learned.levels;if(learned.mapping){const next=JSON.parse(JSON.stringify(config));Object.assign(next.controls.find(c=>c.id===learning.id).mapping,learned.mapping);learning=false;save(next);}}
 }
 const next=sampleControls(config,{gamepad:pad,keys,focused:document.hasFocus()});trails=updateTrails(trails,pressed,next,config.controls,now,config.trails);pressed=next;draw(now);frame=requestAnimationFrame(tick);
}
$('start').addEventListener('click',async()=>{if(running)return;try{const result=await api.command('start');if(!result?.ok)throw Error();running=true;clear();$('start').disabled=true;$('stop').disabled=false;$('device').disabled=config.source!=='gamepad';if(config.source==='keyboard')canvas.focus({preventScroll:true});frame=requestAnimationFrame(tick);}catch{status('Ce viewer n’est pas disponible. Rouvrez-le depuis le Companion.','This viewer is unavailable. Reopen it from Companion.');}});
$('stop').addEventListener('click',()=>{stopLocal();void api.command('stop').catch(()=>{});});
$('device').addEventListener('change',()=>{learning=false;clear();try{const p=pads().find(p=>String(p.index)===$('device').value);selectedDevice=p?.index??null;deviceIdentity=p?identity(p):null;}catch{selectedDevice=null;deviceIdentity=null;}});
$('element').addEventListener('change',()=>{learning=false;selected=$('element').value;form();});
function applyPreset(){const mode=$('preset').value;stopLocal();void api.command('stop').catch(()=>{});const next=preset(mode,en?'en':'fr');selected=next.controls[0].id;save(next);}
$('preset').addEventListener('change',applyPreset);
$('reset').addEventListener('click',applyPreset);
$('reset').textContent=tr('Rétablir les réglages du modèle','Reset this layout');
$('preset').title=tr('Changer de modèle rétablit ses réglages, ses couleurs et ses affectations.','Changing layout resets its settings, colors and mappings.');
$('presentation').addEventListener('click',()=>{document.body.classList.toggle('presentation');$('presentation').textContent=document.body.classList.contains('presentation')?tr('Réglages','Settings'):tr('Masquer les réglages','Hide settings');});
$('presentation').title=tr('Échap ou double-clic sur le viewer pour retrouver les réglages.','Escape or double-click the viewer to restore settings.');
canvas.addEventListener('dblclick',()=>document.body.classList.remove('presentation'));
window.addEventListener('keydown',event=>{if(event.code==='Escape'&&document.body.classList.contains('presentation'))document.body.classList.remove('presentation');});
for(const id of fieldIds)$(id).addEventListener('change',()=>{
 try{const next=JSON.parse(JSON.stringify(config)),c=next.controls.find(value=>value.id===selected);Object.assign(next,{source:$('source').value,width:Number($('width').value),height:Number($('height').value),background:$('background').value,bloom:Number($('bloom').value),showNames:$('names').checked,deadzone:Number($('deadzone').value)});
  Object.assign(c,{label:$('label').value,color:$('color').value,shape:$('shape').value,visible:$('visible').checked,fontSize:Number($('font').value),x:Number($('x').value),y:Number($('y').value),width:Number($('pad-width').value),height:Number($('pad-height').value),mapping:{kind:$('kind').value,index:Number($('index').value),direction:Number($('direction').value),threshold:Number($('threshold').value),key:$('key').value}});
  Object.assign(next.trails,{enabled:$('trails').checked,durationMs:Number($('duration').value),intensity:Number($('intensity').value),length:Number($('length').value),speedPxPerSecond:Number($('speed').value),thickness:Number($('thickness').value),direction:$('trail-direction').value,fade:Number($('fade').value)});
  for(const item of next.controls){item.width=Math.min(item.width,next.width);item.height=Math.min(item.height,next.height);item.x=Math.max(0,Math.min(item.x,next.width-item.width));item.y=Math.max(0,Math.min(item.y,next.height-item.height));}
  validateConfig(next);if(next.source!==config.source){stopLocal();void api.command('stop').catch(()=>{});}save(next);
 }catch{$('feedback').textContent=tr('Valeur invalide : vérifiez les limites et les dimensions.','Invalid value: check the limits and dimensions.');form();}
});
$('learn').addEventListener('click',()=>{if(config.source==='gamepad'){if(!running||selectedDevice===null){$('feedback').textContent=tr('Démarrez puis choisissez une manette avant l’association.','Start and choose a controller before mapping.');return;}learning={kind:'gamepad',id:selected,levels:null,at:performance.now(),threshold:config.controls.find(c=>c.id===selected).mapping.threshold};$('feedback').textContent=tr('Relâchez puis appuyez sur le bouton ou l’axe à associer. Échap annule ; délai 15 secondes.','Release, then press the button or axis to map. Escape cancels; 15-second limit.');}else{learning={kind:'keyboard'};$('feedback').textContent=tr('Appuyez sur une touche dans cette fenêtre. Échap annule.','Press a key in this window. Escape cancels.');}});
const editing=target=>!!target?.closest?.('input,select,textarea,button');
window.addEventListener('keydown',event=>{if((!running&&!learning)||!document.hasFocus())return;if(learning){if(event.code==='Escape'){learning=false;return;}if(learning.kind==='keyboard'&&KEY_CODES.includes(event.code)){event.preventDefault();learning=false;const next=JSON.parse(JSON.stringify(config));next.controls.find(c=>c.id===selected).mapping.key=event.code;save(next);}return;}if(config.source==='keyboard'&&!editing(event.target)&&KEY_CODES.includes(event.code)){event.preventDefault();keys.add(event.code);}});
window.addEventListener('keyup',event=>{if(running&&config.source==='keyboard'&&document.hasFocus())keys.delete(event.code);});
window.addEventListener('blur',()=>{learning=false;if(config.source==='keyboard')clear();});
const point=event=>{const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)/rect.width*config.width,y:(event.clientY-rect.top)/rect.height*config.height};};
canvas.addEventListener('pointerdown',event=>{canvas.focus({preventScroll:true});if(document.body.classList.contains('presentation'))return;const p=point(event),c=[...config.controls].reverse().find(c=>c.visible&&p.x>=c.x&&p.x<=c.x+c.width&&p.y>=c.y&&p.y<=c.y+c.height);if(c){selected=c.id;drag={id:c.id,from:p,x:c.x,y:c.y};canvas.setPointerCapture(event.pointerId);form();draw();}});
canvas.addEventListener('pointermove',event=>{if(!drag)return;const p=point(event),c=config.controls.find(c=>c.id===drag.id);c.x=Math.round(Math.max(0,Math.min(config.width-c.width,drag.x+p.x-drag.from.x)));c.y=Math.round(Math.max(0,Math.min(config.height-c.height,drag.y+p.y-drag.from.y)));$('x').value=c.x;$('y').value=c.y;draw();});
const finishDrag=()=>{if(drag){drag=null;save(config);}};canvas.addEventListener('pointerup',finishDrag);canvas.addEventListener('pointercancel',finishDrag);
const unsubscribe=api?.subscribe(value=>{if(value?.phase!=='running')stopLocal();});
window.addEventListener('beforeunload',()=>{disposed=true;stopLocal();unsubscribe?.();});window.addEventListener('resize',()=>draw());
form();stopLocal();void api?.command('snapshot').catch(()=>{});
