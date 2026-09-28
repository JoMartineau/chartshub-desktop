const {test}=require('node:test'),assert=require('node:assert/strict');const {batchValid,downloadBatch}=require('../batch-download');
const endpoint=n=>'/api/charts/12345678-1234-1234-1234-123456789012/chartabcdef'+n+'/download-manifest';
test('batch permits more than 100 charts but rejects duplicate, external and admin endpoints',()=>{assert.equal(batchValid(Array.from({length:150},(_,i)=>endpoint(i))),true);for(const value of [[],[endpoint(1),endpoint(1)],['https://evil.test'],[endpoint(1).replace('/charts/','/admin/charts/')]])assert.equal(batchValid(value),false);});
test('charts run sequentially in the same directory and failures do not discard successes',async()=>{let active=0,max=0;const result=await downloadBatch({endpoints:[endpoint(1),endpoint(2),endpoint(3)],directory:'chosen-folder',signal:new AbortController().signal,download:async options=>{assert.equal(options.directory,'chosen-folder');active++;max=Math.max(max,active);await Promise.resolve();active--;if(options.endpoint===endpoint(2))throw Error('Unavailable');return {folderName:'saved',files:2};}});assert.equal(max,1);assert.deepEqual(result.results.map(r=>r.ok),[true,false,true]);assert.equal(result.ok,false);});
test('cancellation stops before the next chart and reports already completed charts',async()=>{const controller=new AbortController();let calls=0;const result=await downloadBatch({endpoints:[endpoint(1),endpoint(2)],signal:controller.signal,download:async()=>{calls++;controller.abort();return {folderName:'saved',files:1};}});assert.equal(calls,1);assert.equal(result.cancelled,true);assert.equal(result.results.length,1);});

test('batch events retain chart endpoint and individual percentage beside total progress',async()=>{
 const events=[];await downloadBatch({endpoints:[endpoint(1),endpoint(2)],signal:new AbortController().signal,progress:event=>events.push(event),download:async options=>{options.progress({percent:50,message:'Audio'});return {folderName:'Saved',files:1};}});
 const halfway=events.filter(event=>event.itemPercent===50);assert.deepEqual(halfway.map(event=>[event.endpoint,event.itemPercent,event.percent]),[[endpoint(1),50,25],[endpoint(2),50,75]]);assert.equal(events.filter(event=>event.state==='complete').length,2);
});

test('an idle chart fails precisely while remaining charts continue and can be retried',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-batch-idle-')),value='song';
 const {downloadChart}=require('../download');let stalled=true;
 const options={directory:root,signal:new AbortController().signal,
  // Only the deliberately stalled request uses an accelerated deadline. Real
  // filesystem writes must not depend on finishing within 30 ms on a CI runner.
  download:options=>downloadChart({...options,idleTimeoutMs:stalled&&options.endpoint===endpoint(1)?30:5000}),
  fetcher:async url=>stalled&&url.includes('chartabcdef1')?new Promise(()=>{}):url.endsWith('download-manifest')?Response.json({title:'Saved',files:[{parts:['song.ini'],size:4,sha256:crypto.createHash('sha256').update(value).digest('hex'),url:new URL(url).pathname.replace('download-manifest','files/fileabcdefghijk')}]}):new Response(value)};
 try{
  const result=await downloadBatch({...options,endpoints:[endpoint(1),endpoint(2)]});
  assert.deepEqual(result.results.map(item=>item.ok),[false,true]);assert.match(result.results[0].error,/aucune donnée/);assert.equal(result.cancelled,false);assert.deepEqual(fs.readdirSync(root),['Saved']);
  stalled=false;const retried=await downloadBatch({...options,endpoints:[endpoint(1)]});
  assert.equal(retried.ok,true);assert.deepEqual(fs.readdirSync(root).sort(),['Saved','Saved (2)']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
