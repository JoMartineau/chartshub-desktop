'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDownloadState}=require('../download-state');
test('main-process snapshots restore each chart independently after renderer navigation',()=>{
 const events=[],state=createDownloadState(value=>events.push(value));state.begin(['/chart/a','/chart/b'],'batch');state.progress({endpoint:'/chart/a',state:'complete',itemPercent:100,percent:50,folderName:'A'});state.progress({endpoint:'/chart/b',state:'downloading',itemPercent:26,percent:63,message:'B audio'});
 const restored=state.snapshot();assert.equal(restored.operation.active,true);assert.deepEqual(restored.items.map(item=>[item.endpoint,item.status,item.percent]),[['/chart/a','complete',100],['/chart/b','downloading',26]]);assert.equal(restored.operation.percent,63);
 restored.items[1].percent=99;restored.operation.endpoints.pop();assert.equal(state.snapshot().items[1].percent,26);assert.equal(state.snapshot().operation.endpoints.length,2);assert.ok(events.at(-1).revision>events[0].revision);
});
test('batch cancellation keeps successes and makes pending charts retryable',()=>{
 const state=createDownloadState();state.begin(['/chart/a','/chart/b','/chart/c'],'batch');state.finish({cancelled:true,results:[{endpoint:'/chart/a',ok:true,folderName:'A',destination:'C:/private/path'}]});
 const snapshot=state.snapshot();assert.deepEqual(snapshot.items.map(item=>item.status),['complete','cancelled','cancelled']);assert.equal(snapshot.operation.active,false);assert.equal(snapshot.operation.complete,1);assert.equal(JSON.stringify(snapshot).includes('C:/private/path'),false);
 state.begin(['/chart/b'],'single');assert.equal(state.snapshot().items.find(item=>item.endpoint==='/chart/a').status,'complete');assert.equal(state.snapshot().items.find(item=>item.endpoint==='/chart/b').status,'queued');
});
test('unexpected endpoints cannot alter state for another operation',()=>{
 const state=createDownloadState();state.begin(['/chart/a'],'single');const revision=state.snapshot().revision;state.progress({endpoint:'/other',itemPercent:90,percent:90});assert.equal(state.snapshot().revision,revision);state.finish({ok:false,error:'Permission denied'});assert.equal(state.snapshot().items[0].status,'error');assert.equal(state.snapshot().items[0].error,'Permission denied');
});
