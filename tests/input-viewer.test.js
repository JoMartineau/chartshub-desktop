'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const scope={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../companion/ui/input-viewer-model.js'),'utf8').replaceAll('export const ','const ').replaceAll('export function ','function ')+'\nthis.model={preset,validateConfig,readConfig,writeConfig,sampleControls,updateTrails,trailGeometry,learnGamepadMapping,gridPosition,STORAGE_KEY,LEGACY_STORAGE_KEY};',scope);
const model=scope.model,plain=value=>JSON.parse(JSON.stringify(value));
test('legacy viewer settings gain appearance defaults without losing positions, mappings or labels',()=>{
 const previous=plain(model.preset('drums5'));previous.version=1;delete previous.renderStyle;delete previous.grid;delete previous.trails.style;
 for(const c of previous.controls){delete c.palette;delete c.trailDirection;}
 previous.controls[0].x=91;previous.controls[0].label='Mon pad';previous.controls[0].mapping.kind='button';previous.controls[0].mapping.index=6;
 let writes=0;const restored=model.readConfig({getItem:key=>key===model.LEGACY_STORAGE_KEY?JSON.stringify(previous):null,setItem(){writes++;}});
 assert.equal(writes,0);assert.equal(restored.renderStyle,'cyberpunk');assert.equal(restored.controls[0].x,91);assert.equal(restored.controls[0].label,'Mon pad');assert.equal(restored.controls[0].mapping.index,6);
 assert.equal(restored.controls[0].palette.trail,null);assert.equal(restored.controls[0].trailDirection,null);
 assert.equal(restored.version,2);
});

test('v2 migration preserves expanded v1 colors, styles, bindings and positions without overwriting the rollback key',()=>{
 const previous=plain(model.preset('drums5'));previous.version=1;previous.renderStyle='hologram';previous.grid={enabled:false,size:24};previous.trails.style='comet';
 Object.assign(previous.controls[0],{label:'Mon pad conservé',x:91,y:170,width:90,height:90,color:'#123456',visible:false,fontSize:24,trailDirection:'right',palette:{idle:'#345678',trail:'#abcdef',label:'#fedcba'},mapping:{kind:'axis',index:9,direction:-1,threshold:.7,key:'KeyQ'}});
 const legacyBytes=JSON.stringify(previous),values=new Map([[model.LEGACY_STORAGE_KEY,legacyBytes]]),writes=[];
 const storage={getItem:key=>values.get(key)??null,setItem(key,raw){writes.push(key);values.set(key,raw);}};
 const restored=model.readConfig(storage);assert.deepEqual(plain(restored),{...previous,version:2,grid:{...previous.grid,visible:true}});assert.equal(writes.length,0);
 restored.controls[0].x=125;model.writeConfig(storage,restored);
 assert.deepEqual(writes,['chartshub:input-viewer-config-v2']);assert.equal(values.get(model.LEGACY_STORAGE_KEY),legacyBytes);
 assert.equal(JSON.parse(values.get(model.LEGACY_STORAGE_KEY)).version,1);assert.equal(JSON.parse(values.get(model.STORAGE_KEY)).version,2);
 assert.equal(model.readConfig(storage).controls[0].x,125);assert.equal(previous.controls[0].x,91);
});

test('a valid v2 configuration takes precedence and never reads or changes the legacy key',()=>{
 const current=plain(model.preset());current.controls[0].label='Réglage v2';current.renderStyle='glass';
 const previous=plain(model.preset('drums4'));previous.version=1;const reads=[];
 const storage={getItem(key){reads.push(key);return JSON.stringify(key===model.STORAGE_KEY?current:previous);},setItem(){assert.fail('Reading must not save settings');}};
 assert.deepEqual(plain(model.readConfig(storage)),current);assert.deepEqual(reads,[model.STORAGE_KEY]);
});

test('malformed or wrongly versioned v2 falls back to validated v1 without accepting unsafe legacy fields',()=>{
 const previous=plain(model.preset('drums4'));previous.version=1;previous.controls[0].label='Sauvegarde v1';
 for(const raw of ['broken','x'.repeat(16385),JSON.stringify({...model.preset(),version:999}),JSON.stringify(previous),JSON.stringify({...model.preset(),unexpected:'field'})]){
  const values=new Map([[model.STORAGE_KEY,raw],[model.LEGACY_STORAGE_KEY,JSON.stringify(previous)]]);
  const restored=model.readConfig({getItem:key=>values.get(key)});assert.equal(restored.version,2);assert.equal(restored.controls[0].label,'Sauvegarde v1');
 }
 for(const unsafe of [{...previous,keyHistory:[]},{...previous,version:0},{...previous,version:3},{...previous,version:2}]){
  const fallback=model.readConfig({getItem:key=>key===model.LEGACY_STORAGE_KEY?JSON.stringify(unsafe):null},'en');
  assert.equal(fallback.mode,'guitar');assert.equal(fallback.controls[0].label,'Green');assert.equal(fallback.version,2);
 }
});

test('0.14.32-shaped v1 migrates without changing its original shapes or rollback bytes',()=>{
 const previous=plain(model.preset('drums5'));previous.version=1;previous.bloom=16;
 delete previous.grid;delete previous.renderStyle;delete previous.trails.style;
 for(const c of previous.controls){delete c.palette;delete c.trailDirection;if(c.shape==='cymbal'){c.shape='rect';c.width=110;c.height=32;}if(c.shape==='star')c.shape='diamond';}
 const legacy=JSON.stringify(previous),values=new Map([[model.LEGACY_STORAGE_KEY,legacy]]);
 const restored=model.readConfig({getItem:key=>values.get(key),setItem(key,raw){values.set(key,raw);}});
 assert.equal(restored.controls.find(c=>c.id==='cymbal0').shape,'rect');assert.equal(restored.controls.find(c=>c.id==='power').shape,'diamond');assert.equal(restored.bloom,16);
 model.writeConfig({setItem(key,raw){values.set(key,raw);}},restored);assert.equal(values.get(model.LEGACY_STORAGE_KEY),legacy);
 assert.deepEqual(JSON.parse(legacy),previous);assert.equal(restored.version,2);
});
test('render styles and independent control colors persist with strict safe color and bloom bounds',()=>{
 for(const style of ['cyberpunk','metal','minimal','hologram','arcade','glass','wireframe','energy','plasma','crystal','synthwave','industrial']){const c=model.preset();c.renderStyle=style;c.bloom=80;c.controls[0].palette={idle:'#123456',trail:'#abcdef',label:'#654321'};let saved;model.writeConfig({setItem(_key,raw){saved=raw;}},c);assert.deepEqual(plain(model.readConfig({getItem:()=>saved})),plain(c));}
 for(const mutate of [c=>c.renderStyle='script',c=>c.bloom=81,c=>c.controls[0].palette.idle='url(x)',c=>c.controls[0].palette.label='#fff',c=>c.controls[0].palette.trail={},c=>c.controls[0].trailDirection='diagonal']){const c=model.preset();mutate(c);assert.throws(()=>model.validateConfig(c));}
});
test('each control can override afterglow direction while other controls follow the global direction',()=>{
 const c=model.preset();c.trails.direction='up';c.trails.thickness=100;const item=c.controls[0],trace={id:item.id,at:0};
 item.trailDirection='right';let g=model.trailGeometry(item,trace,100,c.trails);assert(g.x>item.x);assert.equal(g.y,item.y);
 item.trailDirection='left';g=model.trailGeometry(item,trace,100,c.trails);assert(g.x<item.x);assert.equal(g.y,item.y);
 item.trailDirection='down';g=model.trailGeometry(item,trace,100,c.trails);assert.equal(g.x,item.x);assert(g.y>item.y);
 item.trailDirection=null;g=model.trailGeometry(item,trace,100,c.trails);assert.equal(g.x,item.x);assert(g.y<item.y);
 const another=c.controls[1];g=model.trailGeometry(another,{id:another.id,at:0},100,c.trails);assert.equal(g.x,another.x);assert(g.y<another.y);
});
test('all afterglow styles survive saving while legacy settings select soft glow and invalid styles are rejected',()=>{
 for(const style of ['soft','comet','particles','pulse','beam','pixel']){const c=model.preset();c.trails.style=style;let raw;model.writeConfig({setItem(_key,value){raw=value;}},c);assert.equal(model.readConfig({getItem:()=>raw}).trails.style,style);}
 const old=plain(model.preset());delete old.trails.style;assert.equal(model.validateConfig(old).trails.style,'soft');
 old.trails.style='untrusted()';assert.throws(()=>model.validateConfig(old));
});
test('grid alignment stays inside the canvas, can be disabled, and rejects malformed stored grid settings',()=>{
 assert.equal(model.gridPosition(201,680,{enabled:true,size:16}),208);
 assert.equal(model.gridPosition(999,680,{enabled:true,size:16}),672);
 assert.equal(model.gridPosition(-20,680,{enabled:true,size:16}),0);
 assert.equal(model.gridPosition(201,680,{enabled:false,size:16}),201);
 assert.equal(model.gridPosition(10,5,{enabled:true,size:16}),0);
 for(const grid of [{enabled:'yes',size:16},{enabled:true,size:0},{enabled:true,size:999},{enabled:true,size:16,extra:true},{enabled:true,size:16,visible:'yes'},{enabled:true,size:16,visible:null}]){const c=model.preset();c.grid=grid;assert.throws(()=>model.validateConfig(c));}
});

test('grid visibility and magnet alignment remain independent and migrate without enabling disabled alignment',()=>{
 const old=plain(model.preset());old.version=1;old.grid={enabled:false,size:24};
 const migrated=model.validateConfig(old);assert.deepEqual(plain(migrated.grid),{enabled:false,size:24,visible:true});
 assert.equal(model.gridPosition(201,680,migrated.grid),201);
 for(const enabled of [true,false])for(const visible of [true,false]){
  const config=plain(model.preset());config.grid={enabled,visible,size:16};let saved;
  model.writeConfig({setItem(key,raw){assert.equal(key,model.STORAGE_KEY);saved=raw;}},config);
  const restored=model.readConfig({getItem:key=>key===model.STORAGE_KEY?saved:null});
  assert.deepEqual(plain(restored.grid),config.grid);
  assert.equal(model.gridPosition(201,680,restored.grid),enabled?208:201);
 }
});
test('guitar and four/five-pad drum presets validate, remain independently editable and contain no assumed gamepad mappings',()=>{
 for(const mode of ['guitar','drums4','drums5']){const a=model.preset(mode),b=model.preset(mode);assert.equal(model.validateConfig(a).mode,mode);assert(a.controls.every(c=>c.mapping.kind==='none'));assert.equal(a.controls.length,mode==='guitar'?8:mode==='drums4'?9:10);a.controls[0].x=1;assert.notEqual(a.controls[0].x,b.controls[0].x);}
 assert.equal(model.preset('guitar','en').controls[0].label,'Green');assert.equal(model.preset('drums5','en').controls.find(c=>c.id==='kick').label,'Kick');assert.equal(model.preset('drums4','en').controls.find(c=>c.id==='cymbal0').label,'Yellow cymbal');assert.equal(model.readConfig(null,'en').controls[0].label,'Green');
});
test('mapping, composition and effect bounds reject malformed or executable configuration',()=>{
 const mutations=[c=>c.width=Infinity,c=>c.controls[0].x=-1,c=>c.controls[0].width=900,c=>c.controls[0].color='url(javascript:evil)',c=>c.controls[0].fontSize=100,c=>c.controls[0].mapping.index=64,c=>{c.controls[0].mapping.kind='axis';c.controls[0].mapping.index=16;},c=>c.controls[0].mapping.key='UnboundedKey',c=>c.controls[0].mapping.threshold=0,c=>c.trails.durationMs=99999,c=>c.trails.speedPxPerSecond=2001,c=>c.trails.thickness=0,c=>c.trails.fade=0,c=>c.trails.direction='eval()',c=>c.source='global-keyboard',c=>c.controls.push(c.controls[0]),c=>c.keyHistory=[]];
 for(const mutate of mutations){const config=model.preset();mutate(config);assert.throws(()=>model.validateConfig(config));}
});
test('input samples use only assigned actual buttons/axes and locally focused keyboard, never missing devices',()=>{
 const c=model.preset();c.controls[0].mapping={kind:'button',index:2,direction:1,threshold:.5,key:'KeyA'};c.controls[1].mapping={kind:'axis',index:0,direction:-1,threshold:.3,key:'KeyS'};
 assert(Object.values(model.sampleControls(c)).every(value=>value===false));
 const pad={connected:true,buttons:[{value:0},{value:0},{value:.8}],axes:[-.4]};let values=model.sampleControls(c,{gamepad:pad});assert.equal(values.fret0,true);assert.equal(values.fret1,true);assert.equal(values.fret2,false);
 c.deadzone=.5;assert.equal(model.sampleControls(c,{gamepad:pad}).fret1,false);pad.connected=false;assert(Object.values(model.sampleControls(c,{gamepad:pad})).every(value=>value===false));
 c.source='keyboard';assert.equal(model.sampleControls(c,{keys:new Set(['KeyA']),focused:false}).fret0,false);assert.equal(model.sampleControls(c,{keys:new Set(['KeyA']),focused:true}).fret0,true);
});
test('held inputs produce bounded local trails at at most30Hz and expire or clear when disabled',()=>{
 const c=model.preset(),next={fret0:true};let trails=model.updateTrails([],{},next,c.controls,100,c.trails);assert.deepEqual(plain(trails),[{id:'fret0',at:100}]);trails=model.updateTrails(trails,next,next,c.controls,110,c.trails);assert.equal(trails.length,1);trails=model.updateTrails(trails,next,next,c.controls,140,c.trails);assert.equal(trails.length,2);assert.equal(model.updateTrails(trails,next,{},c.controls,1000,c.trails).length,0);assert.equal(model.updateTrails(trails,{},next,c.controls,120,{...c.trails,enabled:false}).length,0);
 const drums=model.preset('drums5'),held=Object.fromEntries(drums.controls.map(c=>[c.id,true])),settings={...drums.trails,durationMs:3000};trails=[];for(let i=0;i<300;i++)trails=model.updateTrails(trails,held,held,drums.controls,i*34,settings);assert(trails.length<=920);assert(trails.length>800);for(const control of drums.controls){const times=trails.filter(t=>t.id===control.id).map(t=>t.at);assert(times.length>1);assert(299*34-times[0]>=2900,'Full configured lifetime retained for simultaneous holds');for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]>=1000/30);}
 const released=model.updateTrails(trails,held,{},drums.controls,300*34,settings);assert(released.length>0);assert(released.every(t=>300*34-t.at<3000));assert.equal(model.updateTrails(released,{}, {},drums.controls,299*34+3001,settings).length,0);
});
test('four trail directions respect independent speed, maximum distance, duration, thickness and opacity',()=>{
 const c=model.preset(),control=c.controls[0],trace={at:0};for(const[direction,vector]of Object.entries({up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]})){const settings={...c.trails,durationMs:1000,speedPxPerSecond:100,length:25,thickness:50,intensity:.8,direction,fade:1},a=model.trailGeometry(control,trace,100,settings),b=model.trailGeometry(control,trace,500,settings);assert.equal(a.x,control.x+control.width/4+vector[0]*10);assert.equal(a.y,control.y+control.height/4+vector[1]*10);assert.equal(b.x,control.x+control.width/4+vector[0]*25);assert.equal(b.y,control.y+control.height/4+vector[1]*25);assert.equal(a.width,control.width/2);assert(Math.abs(a.opacity-.72)<1e-12);assert.equal(b.opacity,.4);assert.equal(model.trailGeometry(control,trace,1000,settings),null);}
});
test('gamepad learning ignores initially held inputs and learns only bounded new button or axis transitions',()=>{
 const pad={connected:true,buttons:[{pressed:true,value:1}],axes:[0]};let result=model.learnGamepadMapping(pad,null);assert.equal(result.mapping,null);result=model.learnGamepadMapping(pad,result.levels);assert.equal(result.mapping,null);pad.buttons[0]={pressed:false,value:0};result=model.learnGamepadMapping(pad,result.levels);pad.buttons[0]={pressed:true,value:1};result=model.learnGamepadMapping(pad,result.levels);assert.deepEqual(plain(result.mapping),{kind:'button',index:0,direction:1});pad.buttons[0]={pressed:false,value:0};result=model.learnGamepadMapping(pad,result.levels);pad.axes[0]=-.8;result=model.learnGamepadMapping(pad,result.levels);assert.deepEqual(plain(result.mapping),{kind:'axis',index:0,direction:-1});assert.equal(result.levels.length,96);assert.equal(model.learnGamepadMapping({connected:false,buttons:[{pressed:true}],axes:[1]},result.levels).mapping,null);
});
test('local storage contains only validated configuration, never played inputs, IDs or history',()=>{
 let stored;const storage={getItem:()=>stored,setItem(key,value){assert.equal(key,model.STORAGE_KEY);stored=value;}};const config=model.preset('drums5');config.controls[0].label='Mon pad personnalisé';model.writeConfig(storage,config);assert.equal(model.readConfig(storage).mode,'drums5');assert.equal(model.readConfig(storage,'en').controls[0].label,'Mon pad personnalisé');assert(!/history|deviceId|pressed|timestamp/.test(stored));stored='invalid';assert.equal(model.readConfig(storage).mode,'guitar');assert.equal(model.readConfig(storage,'en').controls[0].label,'Green');
});
function fixture(){const windows=[],handlers=new Map(),partitions=[],load={nextOutput:null},makeSession=()=>({setPermissionCheckHandler(fn){this.check=fn;},setPermissionRequestHandler(fn){this.permission=fn;},protocol:{async handle(){},async unhandle(){}}}),ses=makeSession(),outputSession=makeSession();
 class Window extends EventEmitter{constructor(options){super();this.options=options;this.dead=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{url:''},sent:[],send(...value){this.sent.push(value);},setWindowOpenHandler(fn){this.open=fn;}});windows.push(this);}isDestroyed(){return this.dead;}async loadURL(url){this.webContents.mainFrame.url=url;if(url===OUTPUT_PAGE&&load.nextOutput){const next=load.nextOutput;load.nextOutput=null;await next();}}setMenuBarVisibility(){}setAlwaysOnTop(...value){this.topmost=value;}show(){this.shown=true;}showInactive(){this.shown=true;}hide(){this.shown=false;}isVisible(){return !this.dead&&this.shown===true;}setIgnoreMouseEvents(value){this.ignoresMouse=value;}setFocusable(value){this.focusable=value;}getBounds(){return{x:20,y:30,width:this.options.width,height:this.options.height};}focus(){}destroy(){if(!this.dead){this.dead=true;this.shown=false;this.emit('closed');}}}
 const electron={BrowserWindow:Window,session:{fromPartition(name){assert(['persist:chartshub-input-viewer','chartshub-input-viewer-output'].includes(name));partitions.push(name);return name==='persist:chartshub-input-viewer'?ses:outputSession;}},ipcMain:{handle(name,fn){handlers.set(name,fn);},removeHandler(name){handlers.delete(name);}},net:{fetch(){throw Error('No remote fetch');}}};return{electron,windows,handlers,ses,outputSession,partitions,load,event:window=>({sender:window.webContents,senderFrame:window.webContents.mainFrame})};
}
const {createInputViewer:actualCreateInputViewer,PAGE,CHANNEL,OUTPUT_PAGE}=require('../companion/input-viewer.cjs');
const createInputViewer=options=>actualCreateInputViewer({...options,xinputFactory:()=>({start(){return false;},select(){return false;},getSelection(){return null;},stop(){},dispose(){}})});
test('viewer opens as an opaque stopped editor, isolates its output session and permits only owned bounded commands',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());assert.equal(f.windows.length,0);assert.equal(service.status().phase,'stopped');const window=await service.open(),invoke=(name,payload)=>f.handlers.get(CHANNEL)(f.event(window),name,payload);
 assert.equal(window.options.transparent,false);assert.equal(window.options.frame,true);assert.equal(window.options.alwaysOnTop,false);assert.equal(window.options.webPreferences.sandbox,true);assert.equal(window.options.webPreferences.nodeIntegration,false);assert.equal(service.status().phase,'stopped');assert.deepEqual(f.partitions,['persist:chartshub-input-viewer','chartshub-input-viewer-output']);assert.equal(f.ses.check(null,'hid'),false);assert.equal(f.outputSession.check(null,'hid'),false);let permission=true;f.outputSession.permission(null,'media',value=>{permission=value;});assert.equal(permission,false);
 for(const name of ['readKeyboard','capture','configure','spawn'])assert.equal((await invoke(name,{})).ok,false);assert.equal((await invoke('start',{path:'private'})).ok,false);assert.equal((await invoke('configure',{config:model.preset()})).ok,true);assert.equal(service.snapshotOutput().config.controls[0].mapping,undefined);assert.equal((await invoke('start',{})).ok,true);assert.equal(service.status().phase,'running');
 assert.equal((await f.handlers.get(CHANNEL)({sender:window.webContents,senderFrame:{url:PAGE}},'stop',{})).ok,false);assert.equal(service.status().phase,'running');assert.equal((await invoke('stop',{})).ok,true);assert.equal(service.status().phase,'stopped');await service.open();assert.equal(f.windows.length,1);service.stop();assert.equal(window.isDestroyed(),true);assert.equal(service.status().phase,'stopped');
});
test('viewer revocation, render failure and disposal close input execution without touching any device',async()=>{
 const f=fixture();let active=true;const service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron,active:()=>active});const window=await service.open();window.webContents.emit('render-process-gone');assert.equal(window.isDestroyed(),true);active=false;assert.equal(await service.open(),null);await service.dispose();assert.equal(f.handlers.has(CHANNEL),false);
});

test('closing controller settings retains the selected native reader, outputs and counts until explicit Stop',async t=>{
 const f=fixture();let callbacks,starts=0,stops=0,selection=0;
 const service=await actualCreateInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron,xinputFactory:value=>{callbacks=value;return{start(){starts++;callbacks.onDevices([{index:0}]);return true;},select(){selection++;return true;},getSelection(){return selection;},stop(){stops++;},dispose(){}};}});t.after(()=>service.dispose());
 const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());config.controls[0].mapping.kind='button';config.controls[0].mapping.index=0;
 await invoke('configure',{config});await invoke('start');await invoke('selectXInput',{index:0});const output=await service.showOutput({editing:false});
 const sample=down=>({index:0,selection,connected:true,buttons:[{pressed:down,value:down?1:0}],axes:[]});callbacks.onSample(sample(false));callbacks.onSample(sample(true));assert.equal(service.snapshotOutput().counts.fret0,1);
 const stopCount=stops;await invoke('close');assert.equal(editor.isDestroyed(),false);assert.equal(editor.isVisible(),false);assert.equal(service.status().open,false);assert.equal(service.status().phase,'running');assert.equal(stops,stopCount);assert.equal(output.isVisible(),true);
 callbacks.onSample(sample(false));assert.equal(service.snapshotOutput().pressed.fret0,false);callbacks.onSample(sample(true));assert.equal(service.snapshotOutput().counts.fret0,2);
 assert.equal(await service.open(),editor);assert.equal(starts,1);assert.equal(service.status().open,true);let prevented=false;editor.emit('close',{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(editor.isVisible(),false);assert.equal(service.status().phase,'running');
 service.stop(false);assert.equal(stops,stopCount+1);assert.equal(service.status().phase,'stopped');assert.equal(service.snapshotOutput().pressed.fret0,false);assert.equal(service.snapshotOutput().counts.fret0,2);
 await service.dispose();assert.equal(editor.isDestroyed(),true);assert.equal(output.isDestroyed(),true);
});

test('hidden browser controller reading keeps its active lease, while closing focused keyboard settings stops it',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());
 let editor=await service.open();const invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());await invoke('configure',{config});await invoke('start');const lease=await invoke('selectXInput',{index:null});
 await invoke('close');assert.equal(service.status().phase,'running');assert.equal(editor.isVisible(),false);
 assert.equal((await invoke('pressed',{run:lease.run,selection:lease.selection,pressed:{fret0:true}})).ok,true);assert.equal(service.snapshotOutput().pressed.fret0,true);
 await invoke('stop');assert.equal((await invoke('pressed',{run:lease.run,selection:lease.selection,pressed:{fret0:true}})).ok,false);assert.equal(service.snapshotOutput().pressed.fret0,false);
 await service.open();config.source='keyboard';await invoke('configure',{config});await invoke('start');await invoke('close');assert.equal(editor.isDestroyed(),true);assert.equal(service.status().phase,'stopped');
 editor=await service.open();assert.equal(service.status().phase,'stopped');assert.equal(service.snapshotOutput().phase,'stopped');
});

test('pending output opens cannot resurrect after hide, stopped outputs revoke access, and failed or crashed outputs are replaced',async t=>{
 const f=fixture();let active=true;const service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron,active:()=>active});t.after(()=>service.dispose());
 let editor=await service.open();const configure=()=>f.handlers.get(CHANNEL)(f.event(editor),'configure',{config:model.preset()});assert.equal((await configure()).ok,true);
 let release;const gate=new Promise(resolve=>{release=resolve;});f.load.nextOutput=()=>gate;
 const pending=service.showOutput({editing:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.windows.length,2);service.hideOutput();release();assert.equal(await pending,null);assert.equal(service.status().outputOpen,false);assert.equal(f.windows[1].isVisible(),false);
 await service.showOutput({editing:true});assert.equal(service.status().outputOpen,true);assert.equal(service.status().phase,'stopped');active=false;await new Promise(resolve=>setTimeout(resolve,180));assert.equal(service.status().outputOpen,false);assert.equal(editor.isDestroyed(),true);assert.equal(f.windows[1].isVisible(),false);
 active=true;editor=await service.open();await configure();f.windows[1].destroy();f.load.nextOutput=()=>Promise.reject(Error('Synthetic load failure'));
 await assert.rejects(service.showOutput({editing:true}),/Synthetic load failure/);const failed=f.windows.at(-1);assert.equal(failed.isDestroyed(),true);assert.equal(service.status().outputOpen,false);
 const restored=await service.showOutput({editing:true});assert.notEqual(restored,failed);assert.equal(restored.isVisible(),true);restored.webContents.emit('render-process-gone');assert.equal(restored.isDestroyed(),true);assert.equal(service.status().outputOpen,false);assert.equal(service.status().phase,'stopped');
});

test('counter snapshots and reset require the owned editor while chart events remain main-only',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload);
 await invoke('configure',{config:model.preset()});assert.equal((await invoke('counterSnapshot')).mode,'guitar');assert.equal((await invoke('resetCounts')).counts.fret0,0);
 for(const name of ['counterSnapshot','resetCounts']){assert.equal((await invoke(name,{counts:{fret0:99}})).ok,false);assert.equal((await f.handlers.get(CHANNEL)({sender:editor.webContents,senderFrame:{url:PAGE}},name,{})).ok,false);}
 for(const name of ['confirmChartStart','confirmChartEnd'])assert.equal((await invoke(name,{id:'synthetic'})).ok,false);
 assert.equal(service.status().phase,'stopped');assert.equal(f.windows.length,1);
});

test('confirmed chart starts are opt-in, require explicit reading and reuse the separate locked output once',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());
 config.autoShowOnChartStart=false;
 await invoke('configure',{config});assert.equal(await service.confirmChartStart('off'),false);config.autoShowOnChartStart=true;await invoke('configure',{config});assert.equal(await service.confirmChartStart('stopped'),false);assert.equal(f.windows.length,1);
 await invoke('start');for(const id of ['',null,{},'bad/path'])assert.equal(await service.confirmChartStart(id),false);
 assert.equal(await service.confirmChartStart('playing:1'),true);const output=service.getOutputWindow();assert.equal(output.ignoresMouse,true);assert.equal(service.status().outputEditing,false);assert.equal(f.windows.length,2);
 service.hideOutput();assert.equal(await service.confirmChartStart('playing:1'),false);assert.equal(output.isVisible(),false);assert.equal(await service.confirmChartStart('playing:2'),true);assert.equal(service.getOutputWindow(),output);assert.equal(f.windows.length,2);assert.equal(service.status().phase,'running');
});

test('automatic chart display hides at the confirmed end, resets counts once and keeps controller reading active',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());config.autoShowOnChartStart=true;config.autoResetOnChartEnd=true;await invoke('configure',{config});await invoke('start');const lease=await invoke('selectXInput',{index:null});const press=pressed=>invoke('pressed',{run:lease.run,selection:lease.selection,pressed});
 await press({});await press({fret0:true});assert.equal(service.snapshotOutput().counts.fret0,1);assert.equal(await service.confirmChartStart('playing:auto'),true);const output=service.getOutputWindow();await invoke('close');assert.equal(editor.isVisible(),false);
 assert.equal(service.confirmChartEnd('playing:auto'),true);assert.equal(output.isVisible(),false);assert.equal(service.status().phase,'running');assert.equal(editor.isDestroyed(),false);assert.equal(service.snapshotOutput().counts.fret0,0);
 await press({});await press({fret0:true});assert.equal(service.snapshotOutput().counts.fret0,1);assert.equal(service.confirmChartEnd('playing:auto'),false);assert.equal(service.snapshotOutput().counts.fret0,1);assert.equal(await service.confirmChartStart('playing:auto'),false);assert.equal(output.isVisible(),false);
 assert.equal(await service.confirmChartStart('playing:new'),true);assert.equal(output.isVisible(),true);
});

test('a confirmed end cancels a pending automatic output and an old end cannot hide a newer chart output',async t=>{
 const f=fixture(),service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload);await invoke('configure',{config:model.preset()});await invoke('start');let release;f.load.nextOutput=()=>new Promise(resolve=>{release=resolve;});const pending=service.confirmChartStart('playing:pending');await new Promise(resolve=>setImmediate(resolve));assert.equal(service.confirmChartEnd('playing:pending'),true);release();assert.equal(await pending,false);assert.equal(service.status().outputOpen,false);
 await service.confirmChartStart('playing:older');await service.confirmChartStart('playing:newer');service.confirmChartEnd('playing:older');assert.equal(service.status().outputOpen,true);service.confirmChartEnd('playing:newer');assert.equal(service.status().outputOpen,false);
});

test('phase tracking is leased only by explicit Start with enabled options and survives closing the settings',async t=>{
 const f=fixture(),calls=[];let connected=false;const service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron,onChartTrackingChange:enabled=>{calls.push(enabled);connected=enabled;},getChartTrackingStatus:()=>({connected,status:connected?'connected':'disabled'})});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());await invoke('configure',{config});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[]);
 await invoke('start');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[true]);assert.equal(service.status().chartAutomation.connected,true);await invoke('close');assert.deepEqual(calls,[true]);assert.equal(service.status().phase,'running');
 config.autoShowOnChartStart=false;config.autoResetOnChartEnd=false;await invoke('configure',{config});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[true,false]);assert.equal(service.status().chartAutomation.requested,false);
 config.autoResetOnChartEnd=true;await invoke('configure',{config});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[true,false,true]);service.stop(false);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[true,false,true,false]);assert.equal(service.status().chartAutomation.requested,false);
});

test('pending automatic output respects Stop, changed options and authorization guards after loading',async t=>{
 for(const cancellation of ['stop','option','guard','active','throw']){
  const f=fixture();let active=true,allowed=true;const service=await createInputViewer({root:path.resolve(__dirname,'../companion'),electron:f.electron,active:()=>active});t.after(()=>service.dispose());const editor=await service.open(),invoke=(name,payload={})=>f.handlers.get(CHANNEL)(f.event(editor),name,payload),config=plain(model.preset());config.autoShowOnChartStart=true;await invoke('configure',{config});await invoke('start');
  let release;f.load.nextOutput=()=>new Promise(resolve=>{release=resolve;});const pending=service.confirmChartStart('start:'+cancellation,()=>{if(allowed==='throw')throw Error('Synthetic revoked');return allowed;});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.windows.length,2);
  if(cancellation==='stop')await invoke('stop');else if(cancellation==='option'){config.autoShowOnChartStart=false;await invoke('configure',{config});}else if(cancellation==='active')active=false;else allowed=cancellation==='throw'?'throw':false;
  release();assert.equal(await pending,false,cancellation);assert.equal(f.windows[1].isVisible(),false,cancellation);await service.dispose();
 }
});
