'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseProbe,createCalibrationHardware}=require('../companion/calibration-hardware.cjs');
const cp=require('node:child_process');
const audio={status:'available',outputName:'Speakers',sampleRateHz:48000,channels:2,defaultPeriodMs:10,minimumPeriodMs:3};
test('Output candidates are bounded friendly labels with default markers, never device identifiers or routes',()=>{
 const result=parseProbe(JSON.stringify({audio,outputs:[{name:'USB Headset serial: SECRET123',kind:'candidate',windowsDefault:false},{name:'Speakers',kind:'candidate',windowsDefault:true},{name:'Speakers',kind:'candidate',windowsDefault:false}],inputs:[]}));
 assert.deepEqual(result.outputs,[{name:'USB Headset',kind:'candidate',windowsDefault:false},{name:'Speakers',kind:'candidate',windowsDefault:true}]);
 assert.equal(JSON.stringify(result).includes('SECRET123'),false);assert.equal(Object.hasOwn(result.outputs[0],'id'),false);
 assert.deepEqual(parseProbe(JSON.stringify({audio,inputs:[]})).outputs,[{name:'Speakers',kind:'candidate',windowsDefault:true}]);
 for(const outputs of [Array(17).fill({name:'x',kind:'candidate',windowsDefault:false}),[{name:'x',kind:'used-by-game',windowsDefault:false}],[{name:'x',kind:'candidate',windowsDefault:'true'}],[{name:'x',kind:'candidate',windowsDefault:false,id:'private'}],null])assert.equal(parseProbe(JSON.stringify({audio,outputs,inputs:[]})).audio.status,'unavailable');
});
test('Refreshing output candidates performs no startup enumeration, is coalesced, and returns defensive copies',async()=>{
 let calls=0,reply;const service=createCalibrationHardware({platform:'win32',screen:{getAllDisplays:()=>[]},execFile(_exe,_args,_options,callback){calls++;reply=callback;}});
 assert.equal(calls,0);assert.deepEqual(service.snapshot().outputs,[]);const a=service.refresh(),b=service.refresh();assert.equal(calls,1);
 reply(null,JSON.stringify({audio,outputs:[{name:'Headset',kind:'candidate',windowsDefault:false}],inputs:[]}));await Promise.all([a,b]);const snapshot=service.snapshot();assert.equal(snapshot.outputs.length,2);snapshot.outputs[0].name='changed';assert.equal(service.snapshot().outputs[0].name,'Headset');
});
function controls(){const source=fs.readFileSync(path.join(__dirname,'../companion/ui/gameplay-controls.js'),'utf8').replace('export class GameplayControls','class GameplayControls');const scope={};vm.runInNewContext(source+'\nthis.Controls=GameplayControls;',scope);return scope.Controls.prototype;}
test('Hardware refresh is independently available during unrelated settings writes and handles a failed request',async()=>{
 const proto=controls();let resolve,calls=0;const state={busy:true,disposed:false,hardwareRefresh:{},snapshot:{hardware:{status:'idle'}},command(name,payload){calls++;assert.equal(name,'telemetry.hardwareRefresh');assert.deepEqual(Object.keys(payload),[]);return new Promise(r=>resolve=r);},renderHardware(){}};
 const pending=proto.refreshHardware.call(state);assert.equal(calls,1);assert.equal(state.hardwareRefreshPending,true);await proto.refreshHardware.call(state);assert.equal(calls,1);resolve({ok:false});await pending;assert.equal(state.hardwareRefreshPending,false);assert.equal(state.hardwareRefreshError,true);assert.equal(state.busy,true);
});
test('Hardware detection stays metadata-only: no capture endpoint, ID read, initialization or device setting is invoked',()=>{
 const script=fs.readFileSync(path.join(__dirname,'../companion/calibration-hardware-windows.ps1'),'utf8');
 const method=script.slice(script.indexOf('public static string[] ReadOutputs()'),script.indexOf('public static AudioMetadata Read()'));
 assert.match(method,/EnumAudioEndpoints\(0, 1, out devices\)/);assert.match(method,/index < 16/);assert.match(method,/OpenPropertyStore\(0,/);
 for(const forbidden of [/\.GetId\(/,/\.Initialize\(/,/\.SetValue\(/,/\.Commit\(/,/\.GetStreamLatency\(/])assert.doesNotMatch(method,forbidden);
 assert.match(script,/outputs = @\(\$outputs\)/);
 assert(Buffer.from(script,'utf16le').toString('base64').length<=30000,'Fixed script must leave space for the Windows command line');
});
function powershell(script){const exe=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');return cp.execFileSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);\n"+script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:16384});}
test('Windows USB function keeps synthetic bus/hub, composite and unknown USB candidates without reading devices',{skip:process.platform!=='win32'},()=>{
 const file=path.resolve(__dirname,'../companion/calibration-hardware-windows.ps1').replaceAll("'","''"),definitions="$tokens=$null;$errors=$null;$source=[IO.File]::ReadAllText('"+file+"',[Text.Encoding]::UTF8);$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Invalid fixed script'};$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Get-SafeFriendlyName','Get-CalibrationInputCandidates')},$true));if($functions.Count -ne 2){throw 'Missing helpers'};foreach($fn in $functions){. ([scriptblock]::Create($fn.Extent.Text))};";
 const fixtures=[{Name:'Guitare USB Exemple',PNPClass:'USB'},{Name:'USB Composite Device Exemple',PNPClass:'USBDevice'},{Name:'Contrôleur hôte USB Exemple',PNPClass:'USB'},{Name:'USB Root Hub Exemple',PNPClass:'USB'},{Name:'Périphérique USB Inconnu Exemple',PNPClass:'WinUSB'},{Name:'Clavier Exemple serial: PRIVATE123',PNPClass:'Keyboard'}];
 const encoded=Buffer.from(JSON.stringify(fixtures),'utf8').toString('base64'),out=powershell(definitions+"\n$devices=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))|ConvertFrom-Json;@(Get-CalibrationInputCandidates -Devices $devices)|ConvertTo-Json -Compress;");
 const values=JSON.parse(out.replace(/^\uFEFF/,''));assert.equal(values.length,6);assert(values.some(x=>x.name==='Guitare USB Exemple'&&x.category==='usb-device'));assert.equal(values.filter(x=>x.category==='usb-bus').length,2);assert(values.some(x=>x.name==='USB Composite Device Exemple'));assert(values.some(x=>x.name==='Périphérique USB Inconnu Exemple'));assert(!out.includes('PRIVATE123'));
});
test('Fixed Windows Core Audio declarations compile without calling any device probe',{skip:process.platform!=='win32'},()=>{
 const source=fs.readFileSync(path.join(__dirname,'../companion/calibration-hardware-windows.ps1'),'utf8'),match=source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@ -ErrorAction Stop/);assert(match);const encoded=Buffer.from(match[1],'utf8').toString('base64');
 const out=powershell("Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))) -ErrorAction Stop;'{\"compiled\":true,\"deviceProbeCalled\":false}'");assert.deepEqual(JSON.parse(out.replace(/^\uFEFF/,'')),{compiled:true,deviceProbeCalled:false});
});
