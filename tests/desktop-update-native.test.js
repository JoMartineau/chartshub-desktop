'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('Windows PowerShell 5.1 updater exercises native transaction guards on synthetic applications',{skip:process.platform!=='win32',timeout:120000},async t=>{
 const directory=await fs.mkdtemp(path.join(process.env.CHARTSHUB_UPDATE_TEST_ROOT||os.tmpdir(),'chartshub-update-fixture-')),root=await fs.realpath(directory);
 t.after(async()=>{assert(path.isAbsolute(root)&&path.basename(root).startsWith('chartshub-update-fixture-'));await fs.rm(root,{recursive:true,force:true});});
 const command=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=spawnSync(command,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'update-installer-fixture.ps1'),'-FixtureRoot',root],{encoding:'utf8',windowsHide:true,shell:false,timeout:110000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const report=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));assert.equal(report.fixtureOnly,true);assert.equal(report.realApplicationTouched,false);assert.equal(report.count,42);assert.equal(report.passed.length,42);
});
