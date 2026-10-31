'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {loadMeasurementFactories,publicMeasurementBundleIgnore}=require('../companion/gameplay-measurements.cjs');
test('public defaults and truthy values never load a provider, installer or hardware module',()=>{
  for(const enabled of [undefined,null,false,0,1,'true',{},[]]){
    let calls=0;assert.equal(loadMeasurementFactories(enabled,()=>{calls++;throw Error('Private module must not load');}),null);assert.equal(calls,0);
  }
});
test('only explicit private opt-in loads the three factories without starting any of them',()=>{
  const calls=[],factories={createTelemetrySource(){throw Error('Not started');},createCalibrationHardware(){throw Error('Not started');},createConnectorSetup(){throw Error('Not started');}};
  const result=loadMeasurementFactories(true,name=>{calls.push(name);return factories;});
  assert.deepEqual(calls,['./clonehero-telemetry-source.cjs','./calibration-hardware.cjs','./connector-setup.cjs']);assert(Object.isFrozen(result));assert.equal(result.createTelemetrySource,factories.createTelemetrySource);
  assert.throws(()=>loadMeasurementFactories(true,()=>({})),/Private measurement components unavailable/);
});
test('the actual public packaging configuration excludes every connector asset and all active measurement services',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../build.mjs'),'utf8');assert.match(source,/createRequire\(import\.meta\.url\)\('\.\/companion\/gameplay-measurements\.cjs'\)/);assert.match(source,/ignore:\[\.\.\.publicMeasurementBundleIgnore,/);
  const ignored=name=>publicMeasurementBundleIgnore.some(rule=>rule.test('/'+name));
  for(const name of ['connector-setup.cjs','connector-setup-download.cjs','connector-setup-payload.cjs','calibration-hardware.cjs','calibration-hardware-windows.ps1','clonehero-telemetry-source.cjs','clonehero-telemetry-model.cjs'])assert.equal(ignored('companion/'+name),true,name);
  const assetDirectory=path.join(__dirname,'../companion/connector-assets');for(const name of fs.readdirSync(assetDirectory))assert.equal(ignored('companion/connector-assets/'+name),true,name);
  for(const name of ['host.cjs','gameplay-measurements.cjs','clonehero-telemetry-view.cjs','clonehero-telemetry-contract.cjs','ui/gameplay-features.js','ui/panel.js','song-visuals.cjs','game-capture.cjs','dist/widgets/core/Gameplay/GameplayWidgets.js','dist/widgets/core/Title/TitleWidget.js'])assert.equal(ignored('companion/'+name),false,name);
});
