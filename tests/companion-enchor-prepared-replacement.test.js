'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {downloadEnchor}=require('../enchor-download');
const request={md5:'a'.repeat(32),title:'Song',artist:'Band'};
function container(){
 const pairs=[['name','Song'],['artist','Band']].map(pair=>pair.map(value=>Buffer.from(value))),entries=[['notes.chart','[Song]\n{}'],['song.ogg','synthetic audio']].map(([name,data])=>({name:Buffer.from(name),data:Buffer.from(data)}));
 const metadataLength=8+pairs.reduce((sum,[key,value])=>sum+8+key.length+value.length,0),indexLength=8+entries.reduce((sum,file)=>sum+17+file.name.length,0),start=26+8+metadataLength+8+indexLength+8;
 const header=Buffer.alloc(start),mask=Buffer.from('0123456789abcdef');let cursor=0;
 const bytes=value=>{value.copy(header,cursor);cursor+=value.length;},u32=value=>{header.writeUInt32LE(value,cursor);cursor+=4;},u64=value=>{header.writeBigUInt64LE(BigInt(value),cursor);cursor+=8;};
 bytes(Buffer.from('SNGPKG'));u32(1);bytes(mask);u64(metadataLength);u64(pairs.length);for(const [key,value]of pairs){u32(key.length);bytes(key);u32(value.length);bytes(value);}
 u64(indexLength);u64(entries.length);let offset=start;for(const file of entries){header[cursor++]=file.name.length;bytes(file.name);u64(file.data.length);u64(offset);offset+=file.data.length;}u64(entries.reduce((sum,file)=>sum+file.data.length,0));
 return Buffer.concat([header,...entries.map(file=>Buffer.from(file.data.map((value,index)=>value^mask[index%16]^(index&255))))]);
}
async function fixture(run){
 const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'enchor-prepared-owner-'));
 try{await run(root);}finally{assert.equal(path.dirname(path.resolve(root)),parent);assert.ok(path.basename(root).startsWith('enchor-prepared-owner-'));fs.rmSync(root,{recursive:true,force:true});}
}
const partialAt=root=>{const name=fs.readdirSync(root).find(name=>name.startsWith('.chartshub-partial-'));return name?path.join(root,name):null;};
const foreign='foreign sentinel; must remain unchanged';
function transfer(root,extra={}){let calls=0;const bytes=container();return {operation:downloadEnchor({request,directory:root,fetcher:async()=>{calls++;return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});},...extra}),calls:()=>calls};}

test('replacing a registered prepared directory refuses future writes and preserves its foreign descendants',{timeout:20000},async()=>fixture(async root=>{
 let observations=0,replaced=false,partial,prepared;
 const job=transfer(root,{guard:async()=>{
  if(replaced)return;partial=partialAt(root);if(!partial)return;prepared=path.join(partial,'prepared-folder');if(!fs.existsSync(prepared)||++observations!==2)return;
  // The original is still empty. Recreate rather than rename so Windows does
  // not need to move a directory while its parent has an open SNG handle.
  assert.deepEqual(fs.readdirSync(prepared),[]);fs.rmdirSync(prepared);await new Promise(resolve=>setTimeout(resolve,5));fs.mkdirSync(prepared);fs.writeFileSync(path.join(prepared,'keep.txt'),foreign);replaced=true;
 }});
 await assert.rejects(job.operation,error=>error.code==='DOWNLOAD_PATH');assert.equal(replaced,true);assert.equal(job.calls(),1);
 assert.equal(fs.readFileSync(path.join(prepared,'keep.txt'),'utf8'),foreign);assert.deepEqual(fs.readdirSync(prepared),['keep.txt']);assert.equal(fs.existsSync(path.join(root,'Band - Song')),false);
}));

test('a replaced decoded file is never published or deleted by partial cleanup',{timeout:20000},async()=>fixture(async root=>{
 let replaced=false,leaf,blockedWhileOpen=0;
 const job=transfer(root,{guard:async()=>{
  if(replaced)return;const partial=partialAt(root);if(!partial)return;leaf=path.join(partial,'prepared-folder','song.ini');if(!fs.existsSync(leaf)||fs.statSync(leaf).size===0)return;
  try{fs.unlinkSync(leaf);}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){blockedWhileOpen++;return;}throw error;}
  await new Promise(resolve=>setTimeout(resolve,5));fs.writeFileSync(leaf,foreign,{flag:'wx'});replaced=true;
 }});
 await assert.rejects(job.operation,error=>error.code==='DOWNLOAD_PATH');assert.equal(replaced,true,'the mutation must run after any Windows open-handle refusal');assert.equal(job.calls(),1);
 assert.equal(fs.readFileSync(leaf,'utf8'),foreign);assert.equal(fs.existsSync(path.join(root,'Band - Song')),false);assert.ok(blockedWhileOpen>=0);
}));

test('a foreign file in the reserved publication directory survives a refused import',{timeout:20000},async()=>fixture(async root=>{
 const reserved=path.join(root,'Band - Song'),leaf=path.join(reserved,'notes.chart');let inserted=false;
 const job=transfer(root,{guard:async()=>{if(!inserted&&fs.existsSync(reserved)){assert.deepEqual(fs.readdirSync(reserved),[]);fs.writeFileSync(leaf,foreign,{flag:'wx'});inserted=true;}}});
 await assert.rejects(job.operation,error=>error.code==='DOWNLOAD_PATH');assert.equal(inserted,true);assert.equal(job.calls(),1);
 assert.equal(fs.readFileSync(leaf,'utf8'),foreign);assert.deepEqual(fs.readdirSync(reserved),['notes.chart']);
}));

test('a foreign leaf inserted during the last cleanup guard is preserved',{timeout:20000},async()=>fixture(async root=>{
 let cleanup=false,cleanupGuards=0,inserted=false,leaf;
 const failure=Error('synthetic failure after the body is closed');
 const job=transfer(root,{progress:value=>{if(value.message==='Vérification du conteneur SNG…'){cleanup=true;throw failure;}},guard:async()=>{
  if(!cleanup||++cleanupGuards!==2)return;const partial=partialAt(root);assert.ok(partial);leaf=path.join(partial,'keep.txt');fs.writeFileSync(leaf,foreign,{flag:'wx'});inserted=true;
 }});
 await assert.rejects(job.operation,error=>error===failure);assert.equal(inserted,true);assert.equal(job.calls(),1);assert.equal(fs.readFileSync(leaf,'utf8'),foreign);
}));
