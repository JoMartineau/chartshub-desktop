'use strict';
// A real Electron main loads the production launcher from ASAR. The harmless
// helper only writes fixture markers; it never invokes the updater installer.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{createRequire}=require('node:module');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 if(process.platform!=='win32'||process.versions.electron)throw Error('Run this Windows fixture using Node.');
 const argument=process.argv[2],output=path.resolve(argument||'');
 if(!argument||output===path.parse(output).root||fs.existsSync(output))throw Error('An explicit NEW fixture output directory is required.');
 const repo=path.resolve(__dirname,'..'),sources=['desktop/update-launcher.cjs','desktop/update-plan.cjs','desktop/update-release.cjs','tests/updater-launcher-fixture.ps1'];
 const sourceHashes=Object.fromEntries(sources.map(n=>[n,hash(fs.readFileSync(path.join(repo,n)))]));
 fs.mkdirSync(output,{recursive:true});const root=fs.realpathSync.native(output),fixture=path.join(root,'fixture'),source=path.join(fixture,'source'),job=path.join(fixture,"job's files");
 for(const dir of [path.join(source,'desktop'),job,path.join(fixture,'electron-profile'),path.join(fixture,'electron-session'),path.join(fixture,'electron-logs')])fs.mkdirSync(dir,{recursive:true});
 for(const name of sources.filter(n=>n.startsWith('desktop/')))fs.copyFileSync(path.join(repo,name),path.join(source,name));
 fs.copyFileSync(path.join(repo,'tests/updater-launcher-fixture.ps1'),path.join(job,'helper.ps1'));
 fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'chartshub-updater-launcher-fixture',version:'0.0.1',main:'controller.cjs'}));
 const controller=String.raw`'use strict';
const {app,BrowserWindow,webContents}=require('electron'),fs=require('node:fs'),original=require('original-fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.argv.find(v=>v.startsWith('--launcher-fixture-root=')).slice('--launcher-fixture-root='.length),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
app.setPath('userData',path.join(root,'electron-profile'));app.setPath('sessionData',path.join(root,'electron-session'));app.setAppLogsPath(path.join(root,'electron-logs'));app.disableHardwareAcceleration();for(const flag of ['disable-background-networking','disable-component-update','disable-sync'])app.commandLine.appendSwitch(flag);
let windows=0,network=0;app.on('browser-window-created',()=>{windows++;});globalThis.fetch=()=>{network++;throw Error('Network forbidden');};
app.whenReady().then(async()=>{try{
 assert.equal(process.versions.electron,'44.4.5');assert.equal(path.basename(__dirname),'app.asar');
 const jobDirectory=path.join(root,"job's files"),helperPath=path.join(jobDirectory,'helper.ps1'),planPath=path.join(jobDirectory,'plan.json'),readyPath=path.join(jobDirectory,'ready.json');
 const plan={jobDirectory,helperSha256:hash(original.readFileSync(helperPath)),controllerPid:process.pid,readyPath,releasedAfterControllerExitPath:path.join(jobDirectory,'released-after-controller-exit'),completedPath:path.join(jobDirectory,'completed.json')};
 original.writeFileSync(planPath,JSON.stringify(plan)+'\n');const planSha256=hash(original.readFileSync(planPath));
 const {launchWindowsHelper}=require('./desktop/update-launcher.cjs');
 await launchWindowsHelper({helperPath,planPath,readyPath,plan,planSha256},new AbortController().signal);
 const ready=JSON.parse(original.readFileSync(readyPath,'utf8'));assert.equal(ready.planSha256,planSha256);assert.equal(ready.marker,'ACTUAL_POWERSHELL_SCRIPT_STARTED');assert(Number.isSafeInteger(ready.helperPid)&&ready.helperPid>0);
 assert.equal(original.existsSync(plan.completedPath),false);assert.equal(original.existsSync(plan.releasedAfterControllerExitPath),false);
 assert.equal(windows,0);assert.equal(BrowserWindow.getAllWindows().length,0);assert.equal(webContents.getAllWebContents().length,0);assert.equal(network,0);
 original.writeFileSync(path.join(root,'controller-report.json'),JSON.stringify({result:'PRODUCTION_LAUNCHER_READY',electron:process.versions.electron,controllerPid:process.pid,helperPid:ready.helperPid,planSha256,windows,webContents:0,externalRequests:network,defaultProductionLauncher:true,loadedFromAsar:true,completedBeforeControllerExit:false,profile:path.join(root,'electron-profile')}));app.exit(0);
}catch(error){original.writeFileSync(path.join(root,'controller-report.json'),JSON.stringify({result:'failed',error:error.message,code:error.code}));app.exit(1);}});
`;
 fs.writeFileSync(path.join(source,'controller.cjs'),controller);
 const asar=path.join(fixture,'app.asar');await createRequire(require.resolve('@electron/packager'))('@electron/asar').createPackage(source,asar);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const errors=[];let errorBytes=0,timedOut=false;
 const child=spawn(require('electron'),[asar,'--launcher-fixture-root='+fixture],{env,windowsHide:true,shell:false,stdio:['ignore','ignore','pipe'],cwd:fixture});
 child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes<=32768)errors.push(b);});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},25000);
 let exitCode;try{exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
 if(errors.length)fs.writeFileSync(path.join(root,'electron-stderr.txt'),Buffer.concat(errors));
 const controllerPath=path.join(fixture,'controller-report.json'),observed=fs.existsSync(controllerPath)?JSON.parse(fs.readFileSync(controllerPath,'utf8')):{result:'failed',error:'Controller report missing'};
 assert.equal(timedOut,false,'Electron fixture timed out');assert.equal(exitCode,0,observed.error);assert.equal(observed.result,'PRODUCTION_LAUNCHER_READY');assert.equal(observed.controllerPid,child.pid);
 // Only after observing normal controller exit do we release the surviving helper.
 fs.writeFileSync(path.join(job,'released-after-controller-exit'),'Controller exited normally with code 0.\n',{flag:'wx'});
 const completedPath=path.join(job,'completed.json'),deadline=Date.now()+15000;while(!fs.existsSync(completedPath)&&Date.now()<deadline)await sleep(50);
 assert(fs.existsSync(completedPath),'PowerShell did not survive the Electron controller');const completed=JSON.parse(fs.readFileSync(completedPath,'utf8'));
 assert.equal(completed.marker,'HELPER_EXECUTED_AFTER_CONTROLLER_EXIT');assert.equal(completed.controllerExited,true);assert.equal(completed.releasedAfterControllerExit,true);assert.equal(completed.planSha256,observed.planSha256);assert.equal(completed.helperPid,observed.helperPid);assert.equal(completed.controllerPid,child.pid);
 assert(sources.every(n=>hash(fs.readFileSync(path.join(repo,n)))===sourceHashes[n]),'Fixture sources changed');
 const passed=['real Electron loads the production launcher from ASAR','default Windows launcher executes the real PowerShell fixture','ready handshake is bound to the exact staged plan hash','helper waits while the Electron controller is alive','Electron exits normally without a window or web contents','PowerShell survives the controller normal exit','post-exit barrier is created only after the controller exit','same verified helper writes the completed marker after parent exit','all application and profile paths stay inside synthetic fixture','no installer, Host, real profile or network is used'];
 const report={result:'UPDATER_LAUNCHER_ELECTRON_OK',count:passed.length,passed,sourceHashes,electron:observed.electron,controllerExitCode:exitCode,timedOut,controllerPid:child.pid,helperPid:observed.helperPid,planSha256:observed.planSha256,defaultProductionLauncher:true,loadedFromAsar:true,readyHandshakeVerified:true,helperExecuted:true,helperSurvivedControllerExit:true,windows:0,webContents:0,externalRequests:0,fixtureOnly:true,realApplicationTouched:false,realProfileTouched:false,installerExecuted:false};
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({result:report.result,count:report.count,report:path.join(root,'report.json')}));
}
if(require.main===module)main().catch(error=>{console.error('Updater launcher fixture FAILED: '+error.message);process.exitCode=1;});module.exports={main};
