const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
let modulePromise;
function media(){return modulePromise??=fs.readFile(path.join(__dirname,'../companion/ui/game-capture-media.js'),'utf8').then(source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')));}
function videoFixture({callbacks=true,play=()=>Promise.resolve()}={}){
 const v=new EventTarget();Object.assign(v,{readyState:0,videoWidth:0,videoHeight:0,play,cancelled:[]});let callback;
 if(callbacks){v.requestVideoFrameCallback=fn=>{callback=fn;return 5;};v.cancelVideoFrameCallback=id=>{v.cancelled.push(id);callback=null;};}
 v.frame=()=>{const fn=callback;callback=null;fn?.();};v.dimensions=()=>{v.readyState=2;v.videoWidth=640;v.videoHeight=360;};return v;
}
test('capture waits for a decoded video frame rather than play() or metadata',async()=>{
 const {startVideoFrames}=await media(),v=videoFixture();let ready=false;const task=startVideoFrames(v,{timeoutMs:2000}).then(size=>{ready=true;return size;});await Promise.resolve();assert.equal(ready,false);
 v.dimensions();v.dispatchEvent(new Event('loadeddata'));await Promise.resolve();assert.equal(ready,false,'rVFC is authoritative when supported');v.frame();assert.deepEqual(await task,{width:640,height:360});
});
test('capture times out when no video arrives even if play() never settles',async()=>{
 const {startVideoFrames}=await media(),v=videoFixture({play:()=>new Promise(()=>{})});await assert.rejects(startVideoFrames(v,{timeoutMs:20}),/no-video-frame/);assert.deepEqual(v.cancelled,[5]);
});
test('stopping a pending start cancels the frame wait without leaving a timer or callback',async()=>{
 const {startVideoFrames}=await media(),v=videoFixture(),abort=new AbortController(),task=startVideoFrames(v,{signal:abort.signal,timeoutMs:2000});abort.abort();await assert.rejects(task,/capture-cancelled/);assert.deepEqual(v.cancelled,[5]);
});
test('legacy video events require actual frame data and media errors keep a bounded public reason',async()=>{
 const {startVideoFrames,captureFailure}=await media(),v=videoFixture({callbacks:false});let ready=false;const task=startVideoFrames(v).then(size=>{ready=true;return size;});v.dispatchEvent(new Event('loadeddata'));await Promise.resolve();assert.equal(ready,false);v.dimensions();v.dispatchEvent(new Event('loadeddata'));await task;
 const denied=Object.assign(Error('private'),{name:'NotAllowedError'});assert.equal(captureFailure(denied),'permission-denied');assert.equal(captureFailure(Error('no-video-frame')),'no-video-frame');assert.equal(captureFailure(Error('private source URL')),'capture-unavailable');
 const broken=videoFixture({play:()=>Promise.reject(denied)});await assert.rejects(startVideoFrames(broken),{name:'NotAllowedError'});assert.deepEqual(broken.cancelled,[5]);
});
