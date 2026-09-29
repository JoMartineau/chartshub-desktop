'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {saveCheckerReport}=require('../chart-checker-report');
const payload=JSON.stringify({engine:'scan-chart',version:'7.0.1',reports:[{title:'Test'}]});
test('report export requires an explicit destination and writes JSON only',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-report-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const filePath=path.join(dir,'report.json');
 assert.deepEqual(await saveCheckerReport({payload,choose:async()=>({canceled:true})}),{ok:false,cancelled:true});assert.deepEqual(await fs.readdir(dir),[]);
 assert.deepEqual(await saveCheckerReport({payload,choose:async()=>({filePath})}),{ok:true});assert.equal(JSON.parse(await fs.readFile(filePath,'utf8')).engine,'scan-chart');
 await assert.rejects(saveCheckerReport({payload,choose:async()=>({filePath:path.join(dir,'payload.cmd')})}));
 assert.deepEqual(await fs.readdir(dir),['report.json']);
});
test('invalid payload and a page change during the save dialog cannot write a file',async()=>{
 await assert.rejects(saveCheckerReport({payload:'malformed',choose:async()=>assert.fail('no dialog')}));
 await assert.rejects(saveCheckerReport({payload,authorized:()=>false,choose:async()=>assert.fail('no dialog')}));
 let valid=true;assert.deepEqual(await saveCheckerReport({payload,authorized:()=>valid,choose:async()=>{valid=false;return {filePath:'invalid.json'};}}),{ok:false,cancelled:true});
});
