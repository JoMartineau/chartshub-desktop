'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {validCommand}=require('../companion/security.cjs');
const id='12345678-1234-4234-8234-123456789abc';
test('Connector setup IPC never accepts a renderer path or omitted installation consent',()=>{
  assert.equal(validCommand('telemetry.connectorChoose',{}),true);
  assert.equal(validCommand('telemetry.connectorPrepare',{hideConsole:true}),true);
  assert.equal(validCommand('telemetry.connectorPrepare',{hideConsole:false}),true);
  for(const payload of [undefined,{}, {hideConsole:'true'}, {hideConsole:true,path:'C:/game'}])assert.equal(validCommand('telemetry.connectorPrepare',payload),false);
  for(const command of ['telemetry.connectorInstall','telemetry.connectorRollback']){
    const key=command.endsWith('Install')?'planId':'receiptId';
    assert.equal(validCommand(command,{[key]:id,confirmation:true}),true);
    for(const payload of [null,{}, {[key]:id}, {[key]:id,confirmation:false}, {[key]:id,confirmation:true,path:'C:/game'}, {[key]:'https://other.test',confirmation:true}])assert.equal(validCommand(command,payload),false);
  }
  assert.equal(validCommand('telemetry.connectorChoose',{path:'C:/game'}),false);
});
test('Setup UI script stays parseable with the existing telemetry model test harness',()=>{
  const file=path.join(__dirname,'../companion/ui/gameplay-controls.js'),source=fs.readFileSync(file,'utf8').replace('export class GameplayControls','class GameplayControls');
  const context={};vm.runInNewContext(source+'\nthis.GameplayControls=GameplayControls;',context);assert.equal(typeof context.GameplayControls.prototype.matchingHardware,'function');
});
test('Display mode changes and disappearance clear both hardware and comparison confirmations',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../companion/ui/gameplay-controls.js'),'utf8').replace('export class GameplayControls','class GameplayControls'),scope={};vm.runInNewContext(source+'\nthis.GameplayControls=GameplayControls;',scope);
  const makeList=(value='')=>({options:[],value,replaceChildren(){this.options=[];}}),list=makeList('display-0'),inputs={replaceChildren(){}};
  const display={key:'display-0',label:'Fixture Display',widthPx:1920,heightPx:1080,refreshHz:144,frameIntervalMs:1000/144};
  const o={snapshot:{hardware:{status:'ready',checkedAt:1,audio:{status:'unavailable'},outputs:[],inputs:[],displays:[display]}},busy:false,hardwareRefresh:{},hardwareStatus:{},hardwareAudio:{},hardwareVideo:{},hardwareInputs:{},hardwareOutput:{value:''},hardwareInput:{value:''},hardwareOutputChoice:makeList(),hardwareInputChoice:makeList(),hardwareConfirmed:{checked:true},comparable:{checked:true},hardwareDisplay:list,hardwareInputList:inputs,tr:(_fr,en)=>en,format:value=>String(value),node(_tag,parent){const entry={};parent.options?.push(entry);return entry;}};
  const render=()=>scope.GameplayControls.prototype.renderHardware.call(o);render();o.hardwareConfirmed.checked=true;o.comparable.checked=true;
  o.snapshot.hardware.checkedAt=2;render();assert.equal(o.hardwareConfirmed.checked,true);assert.equal(o.comparable.checked,true);
  display.refreshHz=240;display.frameIntervalMs=1000/240;display.widthPx=2560;render();assert.equal(o.hardwareConfirmed.checked,false);assert.equal(o.comparable.checked,false);
  o.hardwareConfirmed.checked=true;o.comparable.checked=true;o.snapshot.hardware.displays=[];render();assert.equal(o.hardwareConfirmed.checked,false);assert.equal(o.comparable.checked,false);assert.equal(o.hardwareDisplay.value,'');
});
