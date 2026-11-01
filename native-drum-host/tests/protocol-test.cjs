'use strict';
// Synthetic native-module / protocol verification only. Never send devices or
// start: doing so would enumerate/open real user hardware, which is unnecessary.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const executable=path.join(root,'bin','ChartsHubDrumHost.exe');
const plugin=path.join(root,'build','VST3','ChartsHubDrumTest.vst3');
const checks=[];
function check(name,fn){fn();checks.push(name);}
async function session(run){
 const child=spawn(executable,['--json'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',id=0;const lines=[],pending=new Map();
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;assert(stdout.length<65536);for(;;){const at=stdout.indexOf('\n');if(at<0)break;const line=JSON.parse(stdout.slice(0,at));stdout=stdout.slice(at+1);lines.push(line);if(line.id){const waiter=pending.get(line.id);if(waiter){pending.delete(line.id);waiter.resolve(line);}}}});
 child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;assert(stderr.length<65536);});
 // Node's exit event may precede stdout delivery. close proves that the final
 // reply has drained before diagnosing a missing response.
 const exited=new Promise((resolve,reject)=>{child.on('error',error=>{for(const p of pending.values())p.reject(error);pending.clear();reject(error);});child.on('close',(code,signal)=>{for(const p of pending.values())p.reject(new Error('Native helper closed before replying'));pending.clear();resolve({code,signal});});});
 const timeout=setTimeout(()=>{child.kill();},8000);
 const send=(command,payload={})=>new Promise((resolve,reject)=>{const request={schema:1,id:++id,command,payload};pending.set(request.id,{resolve,reject});child.stdin.write(JSON.stringify(request)+'\n');});
 try{await run({child,send,lines});const exit=await exited;assert.equal(exit.code,0);assert.equal(stderr,'');return lines;}finally{clearTimeout(timeout);child.stdin.end();child.kill();}
}
(async()=>{
 await session(async({send,lines})=>{
   const load=await send('load',{path:plugin});check('load_real_synthetic_plugin_without_start',()=>{assert.equal(load.ok,true);assert.equal(load.result.name,'ChartsHub Offline Test');assert.equal(load.result.hasEditor,false);});
   const note=await send('note',{padId:'kick',velocity:127});check('notes_before_start_rejected',()=>{assert.equal(note.ok,false);assert.equal(note.error,'audio_not_running');});
   const malformed=await send('start',{source:'manual',volume:2});check('invalid_start_rejected_before_hardware',()=>{assert.equal(malformed.ok,false);assert.equal(malformed.error,'integer_required');});
   const errorsBeforeEditor=lines.filter(line=>line.event==='status'&&line.phase==='error').length;
   const editor=await send('editor',{open:true});check('missing_editor_fails_cleanly',()=>{assert.equal(editor.ok,false);assert.equal(editor.error,'plugin_editor_unavailable');assert.equal(lines.filter(line=>line.event==='status'&&line.phase==='error').length,errorsBeforeEditor,'optional missing editor must not emit an engine-stopping status');});
   const panic=await send('panic');check('panic_without_audio_is_safe',()=>assert.equal(panic.ok,true));
   const extra=await send('stop',{unexpected:true});check('unknown_fields_rejected',()=>{assert.equal(extra.ok,false);assert.equal(extra.error,'unknown_field');const replyAt=lines.indexOf(extra);assert(replyAt>0);assert.deepEqual(lines[replyAt-1],{schema:1,event:'status',phase:'error',error:'unknown_field'},'fatal command reports stopped engine before replying');});
   const stop=await send('stop');check('stop_is_idempotent',()=>assert.equal(stop.ok,true));
   const quit=await send('quit');check('quit_reply_then_clean_exit',()=>assert.equal(quit.ok,true));
 });
 await session(async({child,send})=>{assert.equal((await send('load',{path:plugin})).ok,true);child.stdin.end();checks.push('EOF_unloads_plugin_and_exits');});
 await session(async({child})=>{child.stdin.write('x'.repeat(32769)+'\n');checks.push('oversized_input_fails_closed');});
 const deep=await session(async({child})=>{child.stdin.write('{"schema":1,"id":1,"command":"stop","payload":'+'['.repeat(18)+'0'+']'.repeat(18)+'}\n');});
 check('deep_json_fails_closed',()=>assert(deep.some(value=>value.event==='status'&&value.phase==='error')));
 const bytes=await fs.readFile(executable);const report={schema:1,ok:true,checks,helperSha256:crypto.createHash('sha256').update(bytes).digest('hex'),audioDeviceOpened:false,midiDeviceOpened:false,xinputStateRead:false,gameRead:false,profileRead:false};
 await fs.mkdir(path.join(root,'out'),{recursive:true});await fs.writeFile(path.join(root,'out','protocol-test.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
