'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeEnchorRequest,enchorIdentity,validateSngHeader,downloadEnchor,MAX_BYTES,MAX_FILE_BYTES}=require('../enchor-download');
const md5='0123456789abcdef0123456789abcdef',request={md5,title:'Song',artist:'Band'};
function sng({metadata=[['name','Song'],['artist','Band']],files=[['notes.chart','[Song]\n{}'],['song.ogg','original audio'],['video.webm','original video']],version=1}={}){
 const pairs=metadata.map(([key,value])=>[Buffer.from(key),Buffer.from(value)]),entries=files.map(([name,value])=>({name:Buffer.from(name),data:Buffer.from(value)}));
 const metaLength=8+pairs.reduce((sum,[key,value])=>sum+8+key.length+value.length,0),indexLength=8+entries.reduce((sum,file)=>sum+17+file.name.length,0);
 const start=26+8+metaLength+8+indexLength+8,header=Buffer.alloc(start);let position=0;
 const bytes=value=>{value.copy(header,position);position+=value.length;},u32=value=>{header.writeUInt32LE(value,position);position+=4;},u64=value=>{header.writeBigUInt64LE(BigInt(value),position);position+=8;};
 bytes(Buffer.from('SNGPKG'));u32(version);const mask=Buffer.from('0123456789abcdef');bytes(mask);u64(metaLength);u64(pairs.length);
 for(const [key,value]of pairs){u32(key.length);bytes(key);u32(value.length);bytes(value);}
 u64(indexLength);u64(entries.length);let offset=start;
 for(const entry of entries){header[position++]=entry.name.length;bytes(entry.name);u64(entry.data.length);u64(offset);offset+=entry.data.length;}
 u64(entries.reduce((sum,file)=>sum+file.data.length,0));
 return Buffer.concat([header,...entries.map(entry=>Buffer.from(entry.data.map((value,index)=>value^mask[index%16]^(index&255))))]);
}
async function temporary(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-enchor-test-'));try{return await fn(root);}finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}}
const response=bytes=>new Response(bytes,{headers:{'Content-Length':String(bytes.length),'Content-Type':'application/octet-stream'}});
test('external requests admit only a fixed hash and bounded display metadata',()=>{
 assert.deepEqual(normalizeEnchorRequest({md5:md5.toUpperCase(),title:'<b>Song</b>\0',artist:'Band'}),request);
 assert.equal(enchorIdentity(md5),'enchor:'+md5);
 for(const value of [null,[],{},'url',{md5:'a'.repeat(32)+'\n'},{md5:'g'.repeat(32)},{...request,url:'https://evil.test/chart.sng'},{...request,title:{}},{...request,title:'a'.repeat(201)},{md5:'../'+md5}])assert.throws(()=>normalizeEnchorRequest(value));
});
test('browser-compatible validation accepts an incomplete header without retaining payload or requiring Node globals',()=>{
 const bytes=sng(),parsed=validateSngHeader(bytes);
 assert.equal(parsed.totalBytes,bytes.length);assert.equal(parsed.files,3);
 for(let length=0;length<parsed.headerBytes;length++)assert.equal(validateSngHeader(bytes.subarray(0,length)),null);
 assert.deepEqual(validateSngHeader(bytes.subarray(0,parsed.headerBytes)),parsed);
 const vm=require('node:vm'),window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../enchor-sng.js'),'utf8'),{window,Uint8Array,TextDecoder,TextEncoder});
 assert.equal(window.ChartshubEnchorSng.validateSngHeader(new Uint8Array(bytes)).totalBytes,bytes.length);
 const short=bytes.subarray(0,26+8);short.writeBigUInt64LE(1048577n,26);assert.throws(()=>validateSngHeader(short),/SNG valide/);
});
test('SNG headers reject oversized members, unsafe metadata and excessive file counts before payload processing',()=>{
 for(const metadata of [[['name','x\nmalformed']], [['name','Song'],['NAME','Duplicate']], [['bad=key','value']]])assert.throws(()=>validateSngHeader(sng({metadata})),/SNG valide/);
 let bytes=sng(),position=26;position+=8+Number(bytes.readBigUInt64LE(position));const entry=position+16,length=bytes[entry];bytes.writeBigUInt64LE(BigInt(MAX_FILE_BYTES+1),entry+1+length);assert.throws(()=>validateSngHeader(bytes),/SNG valide/);
 bytes=sng();position=26;position+=8+Number(bytes.readBigUInt64LE(position));bytes.writeBigUInt64LE(1001n,position+8);assert.throws(()=>validateSngHeader(bytes),/SNG valide/);
});
test('a 2,070,057,243-byte video and the exact guarded file boundary fit valid SNG headers without large allocations',()=>{
 function videoHeader(size){
  const bytes=sng(),parsed=validateSngHeader(bytes);let index=26;index+=8+Number(bytes.readBigUInt64LE(index));const sectionEnd=index+8+Number(bytes.readBigUInt64LE(index));let cursor=index+16;
  for(let i=0;i<parsed.files;i++){
   const length=bytes[cursor],sizeOffset=cursor+1+length;
   if(i===parsed.files-1){const previous=bytes.readBigUInt64LE(sizeOffset);bytes.writeBigUInt64LE(BigInt(size),sizeOffset);bytes.writeBigUInt64LE(bytes.readBigUInt64LE(sectionEnd)+BigInt(size)-previous,sectionEnd);}
   cursor+=17+length;
  }
  return bytes.subarray(0,parsed.headerBytes);
 }
 for(const size of [2070057243,MAX_FILE_BYTES]){const header=validateSngHeader(videoHeader(size));assert.equal(header.files,3);assert.ok(header.totalBytes>size);assert.ok(header.totalBytes<MAX_BYTES);}
 assert.equal(MAX_FILE_BYTES,2147483644);assert.throws(()=>validateSngHeader(videoHeader(MAX_FILE_BYTES+1)),/SNG valide/);
});
test('complete SNG downloads keep every original byte and reuse the chosen folder without overwriting a chart',async()=>temporary(async root=>{
 const bytes=sng(),calls=[],progress=[],options={request,directory:root,progress:value=>progress.push(value),fetcher:async(url,opts)=>{calls.push(url);assert.equal(url,'https://files.enchor.us/'+md5+'.sng');assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');assert.equal(opts.headers.Cookie,undefined);assert.equal(opts.headers.Authorization,undefined);return response(bytes);}};
 const first=await downloadEnchor(options),second=await downloadEnchor(options);
 assert.equal(first.folderName,'Band - Song');assert.equal(second.folderName,'Band - Song (2)');assert.equal(first.fileName,'Band - Song.sng');assert.equal(first.format,'sng');assert.equal(first.files,3);
 assert.deepEqual(fs.readFileSync(first.destination),bytes);assert.deepEqual(fs.readFileSync(second.destination),bytes);
 assert.deepEqual(fs.readdirSync(root).sort(),[first.folderName,second.folderName]);assert.equal(progress.at(-1).percent,100);assert.equal(calls.length,2);
 const library=await require('../companion/library-scanner.cjs').scanLibrary({rootPath:root});
 assert.equal(library.items.length,2);assert.equal(library.warningCount,0);
 for(const chart of library.items){assert.equal(chart.format,'sng');assert.equal(chart.title,'Song');assert.equal(chart.artist,'Band');assert.equal(chart.audio,'present');}
}));
test('invalid containers, versions, truncated files and mismatched lengths never publish into Songs',async()=>{
 const valid=sng(),modes=[Buffer.from('<html>upstream error</html>'),sng({version:2}),valid.subarray(0,valid.length-1),Buffer.concat([valid,Buffer.from('trailing')])];
 for(const bytes of modes)await temporary(async root=>{fs.writeFileSync(path.join(root,'keep.sng'),'existing');await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>response(bytes)}));assert.deepEqual(fs.readdirSync(root),['keep.sng']);assert.equal(fs.readFileSync(path.join(root,'keep.sng'),'utf8'),'existing');});
 await temporary(async root=>{await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>new Response(valid,{headers:{'Content-Length':String(valid.length+1)}})}),/incomplet/);assert.deepEqual(fs.readdirSync(root),[]);});
});
test('unsafe names, duplicate paths, incompatible path ranges and missing playable files are rejected as a whole',async()=>{
 const cases=[
  [['notes.chart','notes'],['song.ogg','audio'],['../escape.exe','unsafe']],
  [['notes.chart','notes'],['song.ogg','audio'],['SONG.OGG','duplicate']],
  [['notes.chart','notes'],['song.ogg','audio'],['a.txt','x'],['a.txt/b.txt','conflict']],
  [['song.ogg','audio']], [['notes.chart','notes']],
  [['notes.chart','notes'],['song.ogg','audio'],['C:\\escape.txt','unsafe']]
 ];
 for(const files of cases)await temporary(async root=>{await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>response(sng({files}))}),/SNG valide/);assert.deepEqual(fs.readdirSync(root),[]);});
 await temporary(async root=>{const bytes=sng();let p=26;p+=8+Number(bytes.readBigUInt64LE(p));const start=p+16,nameLength=bytes[start];bytes.writeBigUInt64LE(BigInt(bytes.length+1),start+1+nameLength+8);await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>response(bytes)}));assert.deepEqual(fs.readdirSync(root),[]);});
});
test('provider denials stop after one request and discard raw upstream error bodies',async()=>{
 for(const [status,message]of [[403,/refuse/],[404,/plus disponible/],[429,/limite temporairement/],[503,/HTTP 503/]])await temporary(async root=>{let calls=0;await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>{calls++;return new Response('SECRET https://private.example/token',{status});}}),error=>{assert.match(error.message,message);assert.doesNotMatch(error.message,/SECRET|private|token/);return true;});assert.equal(calls,1);assert.deepEqual(fs.readdirSync(root),[]);});
});
test('a refused download releases its job and temporary files even when body cancellation never settles',{timeout:5000},async()=>{
 for(const status of [404,429])await temporary(async root=>{
  let cancelled=0;fs.writeFileSync(path.join(root,'keep.txt'),'keep');
  const stream=new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}});
  await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>new Response(stream,{status})}),status===404?/plus disponible/:/limite temporairement/);
  assert.equal(cancelled,1);assert.deepEqual(fs.readdirSync(root),['keep.txt']);
 });
});
test('headers arriving after an idle timeout have their body cancelled without restarting or leaking the finished job',{timeout:5000},async()=>temporary(async root=>{
 let resolveHeaders,cancelled=0,calls=0;
 await assert.rejects(downloadEnchor({request,directory:root,idleTimeoutMs:30,fetcher:()=>{calls++;return new Promise(resolve=>{resolveHeaders=resolve;});}}),/aucune donnée/);
 assert.deepEqual(fs.readdirSync(root),[]);
 resolveHeaders(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}})));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1);assert.equal(calls,1);assert.deepEqual(fs.readdirSync(root),[]);
}));
test('declared downloads larger than 4 GB, compressed bodies and unexpected redirects are rejected before saving',async()=>{
 const redirected=response(sng());Object.defineProperty(redirected,'redirected',{value:true});
 for(const result of [new Response('x',{headers:{'Content-Length':String(MAX_BYTES+1)}}),new Response('x',{headers:{'Content-Encoding':'gzip'}}),redirected])await temporary(async root=>{await assert.rejects(downloadEnchor({request,directory:root,fetcher:async()=>result}));assert.deepEqual(fs.readdirSync(root),[]);});
});
test('cancelled and stalled streams clean only their operation’s temporary files',async()=>{
 for(const phase of ['headers','body','cancel'])await temporary(async root=>{
  const controller=new AbortController();let cancelled=false;fs.writeFileSync(path.join(root,'keep.txt'),'keep');
  await assert.rejects(downloadEnchor({request,directory:root,signal:controller.signal,idleTimeoutMs:30,fetcher:async()=>{
   if(phase==='headers')return new Promise(()=>{});
   return new Response(new ReadableStream({start(source){if(phase==='cancel')setTimeout(()=>controller.abort(Error('Annulation demandée.')),5);},cancel(){cancelled=true;}}));
  }}),phase==='cancel'?/Annulation demandée/:/aucune donnée/);
  assert.deepEqual(fs.readdirSync(root),['keep.txt']);if(phase!=='headers')assert.equal(cancelled,true);
 });
});
test('a slow but active stream remains usable and is committed only after structural validation',async()=>temporary(async root=>{
 const bytes=sng(),size=32;let observedStaging=false;
 const result=await downloadEnchor({request,directory:root,idleTimeoutMs:80,fetcher:async()=>new Response(new ReadableStream({start(controller){let offset=0;const timer=setInterval(()=>{observedStaging||=fs.readdirSync(root).some(name=>name.startsWith('.chartshub-partial-'));assert.equal(fs.existsSync(path.join(root,'Band - Song.sng')),false);controller.enqueue(bytes.subarray(offset,offset+size));offset+=size;if(offset>=bytes.length){clearInterval(timer);controller.close();}},15);}}),{headers:{'Content-Length':String(bytes.length)}})});
 assert.equal(observedStaging,true);assert.deepEqual(fs.readFileSync(result.destination),bytes);assert.deepEqual(fs.readdirSync(root),['Band - Song']);
}));
