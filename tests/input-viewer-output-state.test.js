'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createInputViewerOutputState, projectOutputSnapshot } = require('../companion/input-viewer-output-state.cjs');
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../companion/ui/input-viewer-model.js'),'utf8').replaceAll('export const ','const ').replaceAll('export function ','function ') + '\nthis.model={preset,validateConfig,sampleControls};', scope);
const model = scope.model, plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let time = 1000;
  const state = createInputViewerOutputState({ validateConfig:model.validateConfig, sampleControls:model.sampleControls, now:() => time });
  return { state, advance: value => { time += value; }, clock: value => { time = value; } };
}

test('output requires the product schema/sampler and starts empty without input or profile access', () => {
  assert.throws(() => createInputViewerOutputState(), /model and clock/);
  const {state} = fixture();
  assert.deepEqual(state.snapshot(), { version:1, revision:0, phase:'stopped', config:null, pressed:{}, counts:{} });
  assert.equal(state.updateGamepad({connected:true}), false); assert.equal(state.updatePressed({fret0:true}), false);
});

test('canonical config is isolated and output snapshots contain only display fields, never input mappings or identity', () => {
  const {state} = fixture(), original = plain(model.preset());
  original.controls[0].mapping = {kind:'button', index:11, direction:1, threshold:.5, key:'KeyQ'};
  const first = state.configure(original);
  assert.deepEqual(Object.keys(first.config).sort(), ['background','bloom','controls','height','renderStyle','showNames','showCounts','trails','width'].sort());
  assert.equal(first.config.controls[0].mapping, undefined); assert.equal(first.config.source, undefined); assert.equal(first.config.deadzone, undefined);
  assert.equal(first.config.grid, undefined); assert(!/mapping|KeyQ|deviceId|axes|buttons/.test(JSON.stringify(first)));
  original.controls[0].x = 900; original.controls[0].palette.idle = '#000000';
  assert.equal(state.snapshot().config.controls[0].x, first.config.controls[0].x);
  assert.equal(state.snapshot().config.controls[0].palette.idle, first.config.controls[0].palette.idle);
  assert(Object.isFrozen(first)); assert(Object.isFrozen(first.config.controls[0].palette));
  assert.throws(() => { first.config.controls[0].palette.idle = '#ffffff'; }, TypeError);
});

test('native samples use actual configured bindings while hidden controls and device identity never enter display state', () => {
  const {state} = fixture(), config = plain(model.preset());
  config.controls[0].mapping = {kind:'button',index:2,direction:1,threshold:.5,key:'KeyA'};
  config.controls[1].mapping = {kind:'axis',index:0,direction:-1,threshold:.3,key:'KeyS'};
  config.controls[1].visible = false; state.configure(config); state.setRunning(true);
  assert.equal(state.updateGamepad({connected:true,id:'PRIVATE GUITAR',index:3,buttons:[{pressed:false},{pressed:false},{pressed:true,value:1}],axes:[-.8]}), true);
  const output = state.snapshot(); assert.equal(output.pressed.fret0, true); assert.equal(Object.hasOwn(output.pressed,'fret1'), false);
  assert(!JSON.stringify(output).includes('PRIVATE GUITAR')); assert.equal(output.config.controls[1].visible,false);
  state.updateGamepad({connected:false}); assert(Object.values(state.snapshot().pressed).every(value => !value));
});

test('browser pressed maps accept known boolean fields only, clear unsafe data and ignore hidden or inherited state', () => {
  const {state} = fixture(), config = plain(model.preset()); config.controls[1].visible = false;
  state.configure(config); state.setRunning(true);
  assert.equal(state.updatePressed({fret0:true,fret1:true}), true);
  assert.deepEqual(Object.entries(state.snapshot().pressed).filter(([,value]) => value), [['fret0',true]]);
  for (const bad of [{fret0:1},{unknown:true},[],null,{fret0:true,deviceId:false}]) {
    state.updatePressed({fret0:true}); assert.equal(state.updatePressed(bad),false);
    assert(Object.values(state.snapshot().pressed).every(value => !value));
  }
  assert.equal(state.updatePressed(Object.create({fret0:true})),true); assert.equal(state.snapshot().pressed.fret0,false);
});

test('stop and clear remove held inputs; delayed samples cannot revive a stopped output', () => {
  const {state} = fixture(); state.configure(model.preset()); state.setRunning(true); state.updatePressed({fret0:true});
  state.clear(); assert.equal(state.snapshot().phase,'running'); assert.equal(state.snapshot().pressed.fret0,false);
  state.updatePressed({fret0:true}); state.setRunning(false);
  assert.equal(state.snapshot().phase,'stopped'); assert.equal(state.snapshot().pressed.fret0,false);
  assert.equal(state.updatePressed({fret0:true}),false); assert.equal(state.updateGamepad({connected:true}),false);
  state.setRunning(true); assert.equal(state.snapshot().pressed.fret0,false);
  assert.throws(() => state.setRunning('yes'),TypeError);
});

test('freshness expires only after500ms; repeated accepted holds renew freshness without unnecessary revisions', () => {
  const {state,advance} = fixture(); state.configure(model.preset()); state.setRunning(true); state.updatePressed({fret0:true});
  const revision = state.snapshot().revision; advance(500); assert.equal(state.snapshot().pressed.fret0,true);
  assert.equal(state.updatePressed({fret0:true}),true); assert.equal(state.snapshot().revision,revision);
  advance(500); assert.equal(state.snapshot().pressed.fret0,true); advance(1);
  const expired = state.snapshot(); assert.equal(expired.pressed.fret0,false); assert(expired.revision > revision);
  assert.equal(state.snapshot().revision,expired.revision);
});

test('clock rollback and invalid time clear old input instead of extending its lifetime', () => {
  const {state,clock} = fixture(); state.configure(model.preset()); state.setRunning(true); state.updatePressed({fret0:true});
  clock(999); assert.equal(state.snapshot().pressed.fret0,false);
  clock(1001); state.updatePressed({fret0:true}); clock(NaN); assert.equal(state.snapshot().pressed.fret0,false);
  assert.equal(state.updatePressed({fret0:true}),false);
});

test('configuration changes clear old bindings while invalid configuration cannot replace a valid setup', () => {
  const {state} = fixture(), config = plain(model.preset()); state.configure(config); state.setRunning(true); state.updatePressed({fret0:true});
  const revision = state.snapshot().revision; state.configure(config); assert.equal(state.snapshot().revision,revision); assert.equal(state.snapshot().pressed.fret0,true);
  const invalid = plain(config); invalid.controls[0].mapping.index = 99;
  assert.throws(() => state.configure(invalid)); assert.equal(state.snapshot().pressed.fret0,true); assert.equal(state.snapshot().revision,revision);
  config.controls[0].color = '#123456'; config.controls[0].mapping.kind = 'button'; config.controls[0].mapping.index = 7;
  state.configure(config); assert.equal(state.snapshot().pressed.fret0,false); assert.equal(state.snapshot().config.controls[0].color,'#123456');
  assert(state.snapshot().revision > revision);
});

test('the shared transport projection strips internal fields, hidden or stopped input and malformed envelopes', () => {
  const {state} = fixture(), config = plain(model.preset()); config.controls[1].visible=false;
  state.configure(config); assert.equal(state.getSource(),'gamepad'); state.setRunning(true); state.updatePressed({fret0:true});
  const raw = plain(state.snapshot());raw.privateIdentity='PRIVATE';raw.config.source='gamepad';raw.config.deadzone=.2;
  raw.config.controls[0].mapping={kind:'button',index:7,key:'KeyQ'};raw.pressed.privateInput=true;raw.pressed.fret1=true;
  const projected=projectOutputSnapshot(raw);assert.equal(projected.pressed.fret0,true);assert.equal(Object.hasOwn(projected.pressed,'fret1'),false);
  assert(!/PRIVATE|privateInput|mapping|KeyQ|deadzone|source/.test(JSON.stringify(projected)));
  raw.phase='stopped';assert.equal(projectOutputSnapshot(raw).pressed.fret0,false);
  for(const bad of [null,{}, {...raw,revision:-1},{...raw,phase:'capture'},{...raw,version:2}]) assert.equal(projectOutputSnapshot(bad),null);
});
