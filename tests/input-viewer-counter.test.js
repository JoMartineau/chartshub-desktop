'use strict';
// Session counters are exercised only with synthetic, already accepted input
// maps/samples. No controller, keyboard hook, device, game or profile is opened.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createInputViewerOutputState,projectOutputSnapshot}=require('../companion/input-viewer-output-state.cjs');
const scope={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../companion/ui/input-viewer-model.js'),'utf8').replaceAll('export const ','const ').replaceAll('export function ','function ')+'\nthis.model={preset,validateConfig,readConfig,writeConfig,sampleControls,STORAGE_KEY,LEGACY_STORAGE_KEY};',scope);
const model=scope.model,plain=value=>JSON.parse(JSON.stringify(value));
function fixture(mode='guitar',overrides={}){
 let time=1000;
 const state=createInputViewerOutputState({validateConfig:model.validateConfig,sampleControls:model.sampleControls,now:()=>time});
 let config={...plain(model.preset(mode)),showCounts:true,...overrides};
 state.configure(config);state.setRunning(true);
 return {state,get config(){return config;},configure(next){config=next;return state.configure(next);},
  press(map={}){time++;assert.equal(state.updatePressed(map),true);return state.snapshot();},
  pad(sample){time++;assert.equal(state.updateGamepad(sample),true);return state.snapshot();},
  advance(ms){time+=ms;},clock(value){time=value;},counts(){return state.snapshot().counts;}};
}
function pulses(f,id,count){f.press({});for(let index=0;index<count;index++){f.press({[id]:true});f.press({});}}

test('counters start at zero per visible control and snapshots alone cannot create input',()=>{
 const f=fixture(),keys=f.config.controls.filter(c=>c.visible).map(c=>c.id);
 assert.deepEqual(Object.keys(f.counts()),keys);assert(Object.values(f.counts()).every(n=>n===0));
 const revision=f.state.snapshot().revision;for(let i=0;i<50;i++)assert.deepEqual(f.counts(),Object.fromEntries(keys.map(id=>[id,0])));
 assert.equal(f.state.snapshot().revision,revision);assert.equal(f.state.getMode(),'guitar');
});

test('an input already held at the first reading must be released before its first count',()=>{
 const f=fixture();f.press({fret0:true});for(let i=0;i<20;i++)f.press({fret0:true});assert.equal(f.counts().fret0,0);
 f.press({});f.press({fret0:true});for(let i=0;i<20;i++)f.press({fret0:true});assert.equal(f.counts().fret0,1);
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,2);
});

test('each control arms independently and simultaneous presses each count one',()=>{
 const f=fixture();f.press({fret0:true});f.press({fret0:true,fret1:true});
 assert.equal(f.counts().fret0,0);assert.equal(f.counts().fret1,1);
 f.press({fret1:true});f.press({fret0:true,fret1:true,down:true,power:true});
 assert.equal(f.counts().fret0,1);assert.equal(f.counts().fret1,1);assert.equal(f.counts().down,1);assert.equal(f.counts().power,1);
 f.press({fret0:true,fret1:true,down:true,power:true});assert.equal(f.counts().down,1);
});

test('synthetic native samples count configured button and axis fronts without exposing device identity',()=>{
 const f=fixture(),config=plain(f.config);Object.assign(config.controls[0].mapping,{kind:'button',index:2});Object.assign(config.controls.find(c=>c.id==='up').mapping,{kind:'axis',index:0,direction:-1,threshold:.5});f.configure(config);
 const pad=(down,axis)=>({connected:true,id:'PRIVATE SYNTHETIC CONTROLLER',index:3,buttons:[{pressed:false},{pressed:false},{pressed:down,value:down?1:0}],axes:[axis]});
 f.pad(pad(true,-.8));assert.equal(f.counts().fret0,0);assert.equal(f.counts().up,0);
 f.pad(pad(false,0));f.pad(pad(true,-.8));f.pad(pad(true,-.9));
 assert.equal(f.counts().fret0,1);assert.equal(f.counts().up,1);assert(!JSON.stringify(f.state.snapshot()).includes('PRIVATE'));
});

test('keyboard samples use the same edge counters without observing the physical keyboard',()=>{
 const f=fixture('guitar',{source:'keyboard'});
 const sample=keys=>model.sampleControls(f.config,{keys:new Set(keys),focused:true});
 f.press(sample([]));f.press(sample(['KeyA','ArrowDown']));f.press(sample(['KeyA','ArrowDown']));
 assert.equal(f.counts().fret0,1);assert.equal(f.counts().down,1);
 f.press(sample([]));f.press(sample(['KeyA']));assert.equal(f.counts().fret0,2);assert.equal(f.counts().down,1);
});

test('drum pads, cymbals, kick and power all have independent session counts',()=>{
 const f=fixture('drums5');f.press({});
 const simultaneous=Object.fromEntries(['pad0','pad4','cymbal0','cymbal2','kick','power'].map(id=>[id,true]));
 f.press(simultaneous);f.press(simultaneous);for(const id of Object.keys(simultaneous))assert.equal(f.counts()[id],1);
 f.press({});f.press({kick:true,cymbal0:true});assert.equal(f.counts().kick,2);assert.equal(f.counts().cymbal0,2);assert.equal(f.counts().pad4,1);
});

test('guitar, four-pad drums and five-pad drums retain isolated totals even for the same control ID',()=>{
 const f=fixture();pulses(f,'power',2);f.configure(plain(model.preset('drums4')));pulses(f,'power',1);
 f.configure(plain(model.preset('drums5')));pulses(f,'power',3);
 f.configure(plain(model.preset('guitar')));assert.equal(f.counts().power,2);assert.equal(f.state.getMode(),'guitar');
 f.configure(plain(model.preset('drums4')));assert.equal(f.counts().power,1);
 f.configure(plain(model.preset('drums5')));assert.equal(f.counts().power,3);
});

test('clear and disconnect preserve totals while a held input on reconnection cannot add a phantom press',()=>{
 const f=fixture();pulses(f,'fret0',2);f.press({fret0:true});assert.equal(f.counts().fret0,3);
 f.state.clear();assert.equal(f.counts().fret0,3);assert.equal(f.state.snapshot().pressed.fret0,false);
 f.press({fret0:true});assert.equal(f.counts().fret0,3);
 f.state.updateGamepad({connected:false});f.press({fret0:true});assert.equal(f.counts().fret0,3);
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,4);
});

test('Stop preserves totals, ignores late samples and re-arms only after release on the next explicit start',()=>{
 const f=fixture();pulses(f,'down',1);f.press({down:true});f.state.setRunning(false);
 assert.equal(f.counts().down,2);assert.equal(f.state.updatePressed({down:true}),false);assert.equal(f.state.updateGamepad({connected:true}),false);
 f.state.setRunning(true);f.press({down:true});assert.equal(f.counts().down,2);f.press({});f.press({down:true});assert.equal(f.counts().down,3);
});

test('freshness expiration keeps totals and is enforced before a new sample even without an intervening snapshot',()=>{
 const f=fixture();pulses(f,'fret0',1);f.advance(501);
 f.press({fret0:true});assert.equal(f.counts().fret0,1,'A stale released state must not arm a later reading');
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,2);
 f.advance(501);assert.equal(f.state.snapshot().pressed.fret0,false);assert.equal(f.counts().fret0,2);
 f.press({fret0:true});assert.equal(f.counts().fret0,2);f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,3);
});

test('clock rollback and malformed input disarm counters without deleting valid totals',()=>{
 const f=fixture();pulses(f,'fret0',1);f.clock(1);assert.equal(f.state.snapshot().pressed.fret0,false);f.press({fret0:true});assert.equal(f.counts().fret0,1);
 for(const bad of [{fret0:1},{unknown:true},null,[]]){assert.equal(f.state.updatePressed(bad),false);f.press({fret0:true});assert.equal(f.counts().fret0,1);}
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,2);
});

test('appearance changes preserve totals and a reconfigured held control is treated as a new baseline',()=>{
 const f=fixture();pulses(f,'fret0',2);f.press({fret0:true});
 const config=plain(f.config);config.controls[0].color='#123456';config.controls[0].x+=8;config.showCounts=false;f.configure(config);
 assert.equal(f.counts().fret0,3);assert.equal(f.state.snapshot().config.showCounts,false);
 f.press({fret0:true});assert.equal(f.counts().fret0,3);f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,4);
});

test('hidden controls neither count nor leak totals, but their existing total returns when shown again',()=>{
 const f=fixture();pulses(f,'fret0',2);const config=plain(f.config);config.controls[0].visible=false;f.configure(config);
 assert.equal(Object.hasOwn(f.counts(),'fret0'),false);f.press({});f.press({fret0:true});assert.equal(Object.hasOwn(f.counts(),'fret0'),false);
 config.controls[0].visible=true;f.configure(config);assert.equal(f.counts().fret0,2);f.press({fret0:true});assert.equal(f.counts().fret0,2);
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,3);
});

test('resetCounts clears every mode and preserves the current held-input baseline',()=>{
 const f=fixture();pulses(f,'power',2);f.configure(plain(model.preset('drums4')));pulses(f,'kick',3);f.press({kick:true});
 const before=f.state.snapshot(),reset=f.state.resetCounts();assert.equal(reset.pressed.kick,true);assert(Object.values(reset.counts).every(n=>n===0));assert(reset.revision>before.revision);
 f.press({kick:true});assert.equal(f.counts().kick,0);f.press({});f.press({kick:true});assert.equal(f.counts().kick,1);
 f.configure(plain(model.preset('guitar')));assert.equal(f.counts().power,0);
});

test('readonly output projections keep bounded safe counts and cannot mutate or increment the broker',()=>{
 const f=fixture();pulses(f,'fret0',2);const before=f.state.snapshot();
 assert(Object.isFrozen(before.counts));assert.throws(()=>{before.counts.fret0=999;},TypeError);
 for(let i=0;i<100;i++){const projected=projectOutputSnapshot(f.state.snapshot());assert.equal(projected.counts.fret0,2);}
 assert.equal(f.state.snapshot().revision,before.revision);
 const raw=plain(before);raw.config.controls[1].visible=false;raw.counts={fret0:Number.MAX_SAFE_INTEGER,fret1:100,fret2:-1,fret3:Infinity,fret4:1.5,up:'3',down:Number.MAX_SAFE_INTEGER+1,secret:42};
 const projected=projectOutputSnapshot(raw);assert.equal(projected.counts.fret0,Number.MAX_SAFE_INTEGER);assert.equal(Object.hasOwn(projected.counts,'fret1'),false);assert.equal(Object.hasOwn(projected.counts,'secret'),false);
 for(const id of ['fret2','fret3','fret4','up','down'])assert.equal(projected.counts[id],0);
 assert.equal(f.counts().fret0,2);
});

test('counter options migrate disabled and session totals never enter saved configuration',()=>{
 const legacy=plain(model.preset());delete legacy.showCounts;delete legacy.autoResetOnChartEnd;
 const normalized=model.validateConfig(legacy);assert.equal(normalized.showCounts,false);assert.equal(normalized.autoResetOnChartEnd,false);
 const f=fixture();pulses(f,'fret0',3);let saved;model.writeConfig({setItem(_key,value){saved=value;}},f.config);
 const stored=JSON.parse(saved);assert.equal(stored.showCounts,true);assert.equal(Object.hasOwn(stored,'counts'),false);assert.equal(Object.hasOwn(stored,'totals'),false);
 const next=fixture();next.configure(stored);assert.equal(next.counts().fret0,0);
 for(const injected of [{...stored,counts:{fret0:300}},{...stored,totals:[1]},{...stored,showCounts:1},{...stored,autoResetOnChartEnd:'yes'}])assert.throws(()=>model.validateConfig(injected));
});

test('hundreds of independent fronts remain exact and repeated held readings do not inflate totals',()=>{
 const f=fixture();pulses(f,'fret0',512);assert.equal(f.counts().fret0,512);
 f.press({fret0:true});for(let i=0;i<512;i++)f.press({fret0:true});assert.equal(f.counts().fret0,513);
 assert(Object.values(f.counts()).every(n=>Number.isSafeInteger(n)&&n>=0));
});

test('automatic reset requires its explicit option and an unseen valid confirmed chart end',()=>{
 const f=fixture('guitar',{autoResetOnChartEnd:true});pulses(f,'fret0',2);f.press({fret0:true});
 assert.equal(f.state.confirmChartEnd('confirmed_attempt:1'),true);assert.equal(f.counts().fret0,0);f.press({fret0:true});assert.equal(f.counts().fret0,0);
 f.press({});f.press({fret0:true});assert.equal(f.counts().fret0,1);assert.equal(f.state.confirmChartEnd('confirmed_attempt:1'),false);assert.equal(f.counts().fret0,1);
 assert.equal(f.state.confirmChartEnd('confirmed_attempt:2'),true);assert.equal(f.counts().fret0,0);
 assert(!JSON.stringify(f.state.snapshot()).includes('confirmed_attempt'));
});

test('turning automatic reset on cannot replay a completion previously confirmed while off',()=>{
 const f=fixture();pulses(f,'fret0',2);assert.equal(f.state.confirmChartEnd('seen-while-off'),false);assert.equal(f.counts().fret0,2);
 const config=plain(f.config);config.autoResetOnChartEnd=true;f.configure(config);
 assert.equal(f.state.confirmChartEnd('seen-while-off'),false);assert.equal(f.counts().fret0,2);
 assert.equal(f.state.confirmChartEnd('new-completion'),true);assert.equal(f.counts().fret0,0);
});

test('invalid completion IDs and ordinary clearing, menus or stopped output never imply a chart end',()=>{
 const f=fixture('guitar',{autoResetOnChartEnd:true});pulses(f,'fret0',2);
 for(const id of ['',null,42,'has space','line\nbreak','../outside','x'.repeat(129)]){assert.equal(f.state.confirmChartEnd(id),false);assert.equal(f.counts().fret0,2);}
 f.state.clear();f.state.setRunning(false);f.advance(600);assert.equal(f.counts().fret0,2);f.state.setRunning(true);assert.equal(f.counts().fret0,2);
});

test('bounded chart-end deduplication still rejects the current completion after long synthetic sessions',()=>{
 const f=fixture('guitar',{autoResetOnChartEnd:true});for(let i=0;i<300;i++)assert.equal(f.state.confirmChartEnd('attempt-'+i),true);
 pulses(f,'fret0',1);assert.equal(f.state.confirmChartEnd('attempt-299'),false);assert.equal(f.counts().fret0,1);
 assert(!JSON.stringify(f.state.snapshot()).includes('attempt-'));
});
