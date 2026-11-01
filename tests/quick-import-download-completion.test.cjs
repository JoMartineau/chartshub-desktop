'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createQuickImportDownloadCompletion}=require('../desktop/quick-import-download-completion.cjs');
const endpoint='/api/charts/12345678-1234-1234-1234-123456789012/chartabcdef1/download-manifest';
const result={folderName:'Signal de test',destination:'C:\\Songs\\Signal de test',files:3};
test('only an authorised new folder completion reaches an existing host with a new private ID',()=>{
 const calls=[];let ids=0;
 const complete=createQuickImportDownloadCompletion({getHost:()=>({acceptDownloadedChart:value=>calls.push(value)}),isAvailable:()=>true,newId:()=>`job-${++ids}`});
 assert.equal(complete({endpoint,result,authorized:true}),true);
 assert.equal(complete({endpoint:'enchor:'+'a'.repeat(32),result:{...result,format:'folder'},authorized:true}),true);
 assert.deepEqual(calls,[{id:'job-1',destination:result.destination,title:result.folderName},{id:'job-2',destination:result.destination,title:result.folderName}]);
});
test('review downloads, packed files, untrusted endpoints and stale authorisation never reach Quick Import',()=>{
 let calls=0;const complete=createQuickImportDownloadCompletion({getHost:()=>{calls++;return{};},isAvailable:()=>true});
 for(const value of [
  {endpoint,result},{endpoint,result,authorized:false},{endpoint:endpoint.replace('/charts/','/admin/charts/'),result,authorized:true},
  {endpoint:'https://example.test',result,authorized:true},{endpoint:'enchor:'+'a'.repeat(32),result:{...result,format:'zip'},authorized:true},
  {endpoint:'enchor:'+'a'.repeat(32),result:{...result,format:'sng'},authorized:true},{endpoint,result:{folderName:'missing'},authorized:true}
 ])assert.equal(complete(value),false);
 assert.equal(calls,0);
});
test('maintenance/account shutdown and a closed Companion do not create a host or replay downloads',()=>{
 let active=false,host=null,hostReads=0,calls=0;
 const complete=createQuickImportDownloadCompletion({getHost:()=>{hostReads++;return host;},isAvailable:()=>active});
 const value={endpoint,result,authorized:true};
 assert.equal(complete(value),false);assert.equal(hostReads,0);
 active=true;assert.equal(complete(value),false);
 host={acceptDownloadedChart:()=>calls++};assert.equal(calls,0);
 assert.equal(complete(value),true);assert.equal(calls,1);
 active=false;assert.equal(complete(value),false);assert.equal(calls,1);
});
test('optional import errors cannot reject a completed chart download',async()=>{
 for(const accept of [()=>{throw Error('closed');},()=>Promise.reject(Error('disconnected'))]){
  const complete=createQuickImportDownloadCompletion({getHost:()=>({acceptDownloadedChart:accept}),isAvailable:()=>true});
  assert.doesNotThrow(()=>complete({endpoint,result,authorized:true}));
 }
 await new Promise(resolve=>setImmediate(resolve));
});
