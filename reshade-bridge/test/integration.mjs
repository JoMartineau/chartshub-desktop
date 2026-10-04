import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {pipeRequest}=require('../../companion/reshade-service.cjs');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime=path.join(root,'test/runtime');
const game='F:/Clone Hero/Clone Hero Launcher/Clone Hero';
const backup=path.join(game,'ChartsHubFilters-backup-2376f762-79cf-4970-9dad-244a64d7db8c/dxgi.dll');
await fs.mkdir(path.join(runtime,'Shaders'),{recursive:true});
for(const file of ['ChartsHubReShade.addon64','chartshub-reshade-test.exe'])await fs.copyFile(path.join(root,'bin',file),path.join(runtime,file));
await fs.copyFile(backup,path.join(runtime,'dxgi.dll'));
await fs.copyFile(path.join(root,'test/ChartsHubTest.fx'),path.join(runtime,'Shaders/ChartsHubTest.fx'));
for(const file of ['ReShade.fxh','ReShadeUI.fxh','qUINT/qUINT_bloom.fx','qUINT/qUINT_common.fxh','SweetFX/FilmGrain.fx','SweetFX/ChromaticAberration.fx'])await fs.copyFile(path.join(game,'reshade-shaders/Shaders',file),path.join(runtime,'Shaders',path.basename(file)));
await fs.writeFile(path.join(runtime,'ReShade.ini'),`[ADDON]\nAddonPath=.\\\nDisabledAddons=Generic Depth\n\n[GENERAL]\nCheckForUpdates=0\nEffectSearchPaths=.\\Shaders\nTextureSearchPaths=.\\Shaders\nPresetPath=.\\TestPreset.ini\nNoEffectCache=1\nNoDebugInfo=1\nPerformanceMode=0\nSkipLoadingDisabledEffects=0\n\n[OVERLAY]\nAutoSavePreset=0\nTutorialProgress=4\n\n[INPUT]\nKeyOverlay=0,0,0,0\nKeyEffects=0,0,0,0\n`);
await fs.writeFile(path.join(runtime,'TestPreset.ini'),'Techniques=\n\n[ChartsHubTest.fx]\nAmount=1.000000\n');
let processOutput='',stdoutPending='',lastFrame=null,closed=false;
const child=spawn(path.join(runtime,'chartshub-reshade-test.exe'),[],{cwd:runtime,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>{processOutput+=s;stdoutPending+=s;let at;while((at=stdoutPending.indexOf('\n'))>=0){const line=stdoutPending.slice(0,at);stdoutPending=stdoutPending.slice(at+1);try{const v=JSON.parse(line);if(v.pixel)lastFrame=v;}catch{}}});child.stderr.on('data',s=>{processOutput+=s;console.log(s.trim());});child.on('exit',(code,signal)=>{closed=true;processOutput+=`\nExit code=${code} signal=${signal}\n`;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const pipe=`\\\\.\\pipe\\ChartsHub-ReShade-${child.pid}`;
let seq=0,checks=0;
function check(value,label){assert.ok(value,label);checks++;console.log(`PASS: ${label}`);}
async function pixelCheck(predicate,label){const first=lastFrame?.frame||0;for(let n=0;n<100;n++){if(lastFrame?.frame>first&&predicate(lastFrame.pixel)){check(true,label);return;}await pause(25);}check(false,`${label}; observed ${JSON.stringify(lastFrame)}`);}
function request(action,extra={}){return new Promise((resolve,reject)=>{
  const socket=net.createConnection(pipe);let data='';const timer=setTimeout(()=>{socket.destroy();reject(new Error(`Timeout ${action}`));},5000);
  socket.on('connect',()=>socket.write(JSON.stringify({id:++seq,action,...extra})+'\n'));socket.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timer);socket.destroy();try{resolve(JSON.parse(data.split('\n')[0]));}catch(e){reject(e);}}});socket.on('error',e=>{clearTimeout(timer);reject(e);});
});}
async function ok(action,extra){const r=await request(action,extra);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
try{
  let status;
  for(let attempt=0;attempt<100;attempt++){if(closed)throw new Error(`Harness exited:\n${processOutput}`);try{status=await ok('status');if(status.runtimeReady)break;}catch{}await pause(200);}
  check(status?.runtimeReady===true,'real ReShade loads addon and creates effect runtime');
  check(status.pid===child.pid&&status.protocol===1&&status.addonVersion==='0.11.0','protocol status identifies correct process and addon');
  check(path.resolve(status.executablePath).toLowerCase()===path.resolve(runtime,'chartshub-reshade-test.exe').toLowerCase(),'executable identity returned for root verification');
  check(status.presetName==='TestPreset.ini','preset path exposed only as basename');
  let catalog;
  for(let attempt=0;attempt<100;attempt++){catalog=await ok('catalog');if(catalog.techniques.some(t=>t.name==='ChartsHubTest')&&catalog.techniques.length>=4)break;await pause(250);}
  let technique=catalog.techniques.find(t=>t.name==='ChartsHubTest');check(!!technique,'real .fx test technique enumerated');
  for(const [name,effect] of [['Bloom','qUINT_bloom.fx'],['FilmGrain','FilmGrain.fx'],['CA','ChromaticAberration.fx']])check(catalog.techniques.some(t=>t.name===name&&t.effect===effect),`installed ${name}@${effect} compiled and discoverable`);
  let uniforms=(await ok('uniforms',{effect:technique.effect})).uniforms;
  let amount=uniforms.find(u=>u.name==='Amount'),shift=uniforms.find(u=>u.name==='Shift'),mode=uniforms.find(u=>u.name==='Mode'),gate=uniforms.find(u=>u.name==='Gate'),timer=uniforms.find(u=>u.name==='Timer');
  const oldUniformId=amount.id,oldGeneration=catalog.generation;
  check(amount?.type==='float'&&amount.min[0]===0&&amount.max[0]===2&&amount.label==='Test amount','scalar float UI metadata matches compiled shader');
  check(shift?.components===2&&shift.min.every(n=>n===-2)&&shift.max.every(n=>n===2),'vector scalar annotations broadcast to each component');
  check(mode?.type==='int'&&mode.items.join(',')==='Normal,Alternate','integer combo embedded-NUL labels preserved');
  check(gate?.type==='bool'&&gate.value[0]===true,'boolean uniform values readable');
  check(timer?.readOnly===true,'automatic source uniform marked read-only');
  const denied=await request('setUniform',{uniformId:timer.id,value:[1]});check(!denied.ok&&denied.error.code==='read_only','automatic uniforms cannot be overridden');
  check(!(await request('setUniform',{uniformId:amount.id,value:[3]})).ok,'annotated bounds enforced');
  check(!(await request('setUniform',{uniformId:shift.id,value:[1]})).ok,'vector shape enforced');
  await ok('setEnabled',{enabled:true});await ok('setTechnique',{techniqueId:technique.id,enabled:true});await pause(5500);
  catalog=await ok('catalog');technique=catalog.techniques.find(t=>t.name==='ChartsHubTest');uniforms=(await ok('uniforms',{effect:technique.effect})).uniforms;
  check(catalog.generation>oldGeneration,'real technique compilation advances handle generation');
  const stale=await request('setUniform',{uniformId:oldUniformId,value:[.9]});check(!stale.ok&&stale.error.code==='stale_id','uniform IDs from before real effect reload are rejected');
  amount=uniforms.find(u=>u.name==='Amount');shift=uniforms.find(u=>u.name==='Shift');mode=uniforms.find(u=>u.name==='Mode');gate=uniforms.find(u=>u.name==='Gate');
  await ok('setUniform',{uniformId:amount.id,value:[.5]});await pause(500);
  await pixelCheck(p=>p[0]>=30&&p[0]<=34,'live uniform edit changes actual ReShade GPU output');
  await ok('setUniform',{uniformId:shift.id,value:[1.5,-.5]});await ok('setUniform',{uniformId:mode.id,value:[1]});await ok('setUniform',{uniformId:gate.id,value:[false]});await pause(300);
  uniforms=(await ok('uniforms',{effect:technique.effect})).uniforms;
  check(uniforms.find(u=>u.name==='Shift').value.join(',')==='1.5,-0.5','vector uniform set and readback');
  check(uniforms.find(u=>u.name==='Mode').value[0]===1&&uniforms.find(u=>u.name==='Gate').value[0]===false,'integer and boolean writes reflected');
  await pixelCheck(p=>p[0]>=62&&p[0]<=66,'boolean shader gate changes actual output');
  await ok('setUniform',{uniformId:gate.id,value:[true]});await ok('savePreset');await pause(1600);
  const saved=await fs.readFile(path.join(runtime,'TestPreset.ini'),'utf8');check(saved.includes('Amount=0.500000')&&saved.includes('ChartsHubTest'),'official save_current_preset persists edited values and technique');
  await ok('setEnabled',{enabled:false});await pixelCheck(p=>p[0]>=62&&p[0]<=66,'global disabled state restores passthrough');
  check((await ok('status')).effectsEnabled===false,'global disabled state reported');
  await ok('setEnabled',{enabled:true});await ok('setTechnique',{techniqueId:technique.id,enabled:false});await pixelCheck(p=>p[0]>=62&&p[0]<=66,'technique disable restores passthrough');
  const grain=catalog.techniques.find(t=>t.name==='FilmGrain');const grainParameters=(await ok('uniforms',{effect:grain.effect})).uniforms;check(grainParameters.some(u=>u.name==='Intensity'&&u.min[0]===0&&u.max[0]===1),'real FilmGrain editable controls delivered');
  const ca=catalog.techniques.find(t=>t.name==='CA');const caParameters=(await ok('uniforms',{effect:ca.effect})).uniforms;check(caParameters.some(u=>u.name==='Shift'&&u.components===2&&u.min[0]===-10),'real chromatic aberration vector controls delivered');
  const bloom=catalog.techniques.find(t=>t.name==='Bloom');const bloomParameters=(await ok('uniforms',{effect:bloom.effect})).uniforms;check(bloomParameters.some(u=>u.name==='BLOOM_INTENSITY'),'real qUINT multi-pass bloom controls delivered');
  check(!(await request('exportPreset',{path:'C:/should-not-exist'})).ok,'arbitrary file/preset actions rejected');
  for(let i=0;i<40;i++){const action=i%2?'catalog':'status';const reply=await pipeRequest(child.pid,{id:++seq,action});assert.equal(reply.pid,child.pid);if(action==='catalog')assert.ok(reply.techniques.some(t=>t.effect==='ChartsHubTest.fx'));}
  check(true,'40 sequential status/catalog calls through actual companion pipeRequest transport');
  console.log(`SUCCESS: ${checks} real ReShade addon integration checks.`);
}finally{
  child.kill();await pause(300);await fs.writeFile(path.join(root,'test/harness-output.log'),processOutput);
}
