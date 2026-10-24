'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {emptyScanProgress,estimateScanRemaining}=require('../companion/library-scan-progress.cjs');
test('scan estimates stay unknown before a representative quick-scan sample',()=>{
 for(const mode of ['full','quick']) assert.equal(estimateScanRemaining({mode,baselineCount:0,knownCompleted:0,elapsedMs:5000}),null);
 assert.equal(estimateScanRemaining({mode:'full',baselineCount:100,knownCompleted:50,elapsedMs:5000}),null);
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:50,elapsedMs:500}),null);
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:1000,knownCompleted:10,elapsedMs:5000}),null);
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:100,elapsedMs:5000}),null);
});
test('a quick-scan estimate reflects measured committed-index progress without claiming completion',()=>{
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:25,elapsedMs:2000}),6000);
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:50,elapsedMs:2000}),2000);
 assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:99,elapsedMs:2000}),1000);
 for(const elapsedMs of [NaN,Infinity,-1,Number.MAX_VALUE]) assert.equal(estimateScanRemaining({mode:'quick',baselineCount:100,knownCompleted:50,elapsedMs}),null);
});
test('new scan metrics start fresh and status snapshots cannot share mutable progress',()=>{
 const a=emptyScanProgress(),b=emptyScanProgress();a.added=3;
 assert.equal(b.added,0);assert.equal(b.estimatedRemainingMs,null);assert.equal(b.skipped,0);assert.equal(b.elapsedMs,0);
});
