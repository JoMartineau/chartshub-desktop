'use strict';
const fs=require('node:fs').promises,path=require('node:path');
const {spawn}=require('node:child_process');
const {plain,fileHash}=require('./update-plan.cjs');
const {fail}=require('./update-release.cjs');
async function launchWindowsHelper(job,signal,{spawnProcess=spawn,clock=()=>Date.now(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(process.platform!=='win32')throw fail('INSTALL_UNSUPPORTED');
 await plain(job.helperPath);await plain(job.planPath);
 if(await fileHash(job.helperPath)!==job.plan.helperSha256||await fileHash(job.planPath)!==job.planSha256)throw fail('PLAN_CHANGED');
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 let launchError;
 // Start-Process gives the helper its own hidden console. A detached
 // PowerShell may exit before reading its script; sharing Electron's console
 // can terminate the helper when Electron exits. Keep the bootstrap unreferenced.
 const literal=value=>"'"+value.replaceAll("'","''")+"'";
 const helperArgs=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',job.helperPath,'-Plan',job.planPath,'-PlanSha256',job.planSha256].map(value=>'"'+value+'"').join(' ');
 const command="$ErrorActionPreference='Stop'; Start-Process -FilePath "+literal(executable)+' -ArgumentList '+literal(helperArgs)+' -WorkingDirectory '+literal(job.plan.jobDirectory)+' -WindowStyle Hidden | Out-Null';
 const child=spawnProcess(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{detached:false,windowsHide:true,stdio:'ignore',shell:false,cwd:job.plan.jobDirectory});
 child.on('error',()=>{launchError=fail('HELPER_START_FAILED');});child.unref();
 const deadline=clock()+15000;
 while(clock()<deadline){
  signal?.throwIfAborted();if(launchError)throw launchError;
  let stat;try{stat=await plain(job.readyPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat){if(stat.size>1024)throw fail('HELPER_START_FAILED');let ready;try{ready=JSON.parse(await fs.readFile(job.readyPath,'utf8'));}catch{throw fail('HELPER_START_FAILED');}if(ready.planSha256!==job.planSha256)throw fail('HELPER_START_FAILED');return;}
  await delay(100);
 }
 throw fail('HELPER_START_FAILED');
}
module.exports={launchWindowsHelper};
