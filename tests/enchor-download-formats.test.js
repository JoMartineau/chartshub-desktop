'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {downloadEnchor,normalizeEnchorDownloadRequest}=require('../enchor-download'),{parseSngHeader}=require('../enchor-sng');
const md5='0123456789abcdef0123456789abcdef',request={md5,title:'Song',artist:'Band'};
function fixture(){
 const metadata=[['name','Song; Part II'],['artist','Band'],['charter','<color=#ffaa00>Author</color>']],files=[['notes.chart',Buffer.from('[Song]\n{}')],['song.ogg',Buffer.from(Array.from({length:131091},(_,i)=>(i*71)%256))],['video.webm',Buffer.from('complete original video')],['extras/tutorial.webm',Buffer.from('keep tutorial')],['extras/été.txt',Buffer.from('all extras retained')]];
 const pairs=metadata.map(([key,value])=>[Buffer.from(key),Buffer.from(value)]),metaLength=8+pairs.reduce((sum,[key,value])=>sum+8+key.length+value.length,0),indexLength=8+files.reduce((sum,[name])=>sum+17+Buffer.byteLength(name),0),headerBytes=26+8+metaLength+8+indexLength+8,header=Buffer.alloc(headerBytes),mask=Buffer.from(Array.from({length:16},(_,i)=>i*13));let position=0;
 const bytes=value=>{value.copy(header,position);position+=value.length;},u32=value=>{header.writeUInt32LE(value,position);position+=4;},u64=value=>{header.writeBigUInt64LE(BigInt(value),position);position+=8;};
 bytes(Buffer.from('SNGPKG'));u32(1);bytes(mask);u64(metaLength);u64(pairs.length);for(const [key,value]of pairs){u32(key.length);bytes(key);u32(value.length);bytes(value);}u64(indexLength);u64(files.length);let offset=headerBytes;
 for(const [name,data]of files){const encoded=Buffer.from(name);header[position++]=encoded.length;bytes(encoded);u64(data.length);u64(offset);offset+=data.length;}u64(files.reduce((sum,[,data])=>sum+data.length,0));
 return {bytes:Buffer.concat([header,...files.map(([,data])=>Buffer.from(data.map((value,index)=>value^mask[index%16]^(index&255))))]),files:new Map(files),ini:'[Song]\nname = Song; Part II\nartist = Band\ncharter = <color=#ffaa00>Author</color>\n'};
}
async function temporary(action){const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-enchor-formats-'));try{return await action(root);}finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}}
const response=bytes=>new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
function readZip(bytes){
 const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);assert.equal(bytes.readUInt32LE(end+16)+bytes.readUInt32LE(end+12),end);let cursor=bytes.readUInt32LE(end+16);const result=new Map();
 for(let i=0;i<bytes.readUInt16LE(end+10);i++){
  assert.equal(bytes.readUInt32LE(cursor),0x02014b50);assert.equal(bytes.readUInt16LE(cursor+10),0,'ZIP members are stored without transcoding');const nameLength=bytes.readUInt16LE(cursor+28),size=bytes.readUInt32LE(cursor+24),local=bytes.readUInt32LE(cursor+42),name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
  assert.equal(bytes.readUInt32LE(local),0x04034b50);const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),data=bytes.subarray(start,start+size);assert.equal(crc32(data),bytes.readUInt32LE(cursor+16));assert.equal(bytes.readUInt32LE(start+size),0x08074b50);assert.equal(bytes.readUInt32LE(start+size+4),crc32(data));assert.equal(bytes.readUInt32LE(start+size+12),size);result.set(name,data);cursor+=46+nameLength+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);
 }
 assert.equal(cursor,end);return result;
}
function decodeSng(bytes){const header=parseSngHeader(bytes);assert.equal(header.totalBytes,bytes.length);return new Map(header.members.map(member=>[member.name,Buffer.from(bytes.subarray(member.position,member.position+member.size).map((value,index)=>value^header.mask[index%16]^(index&255)))]));}
test('download intents have exactly three modes, strict booleans and no renderer path fields',()=>{
 assert.deepEqual(normalizeEnchorDownloadRequest(request),{request,format:'folder',includeVideo:true});
 for(const format of ['folder','zip','sng'])assert.deepEqual(normalizeEnchorDownloadRequest({...request,format,includeVideo:false}),{request,format,includeVideo:false});
 for(const value of [{...request,format:'rar'},{...request,includeVideo:'false'},{...request,outputPath:'/private/out.sng'},{...request,url:'https://private.test/chart'}])assert.throws(()=>normalizeEnchorDownloadRequest(value));
});
test('save-as SNG preserves all provider bytes while ZIP contains real decoded playable files and metadata',async()=>temporary(async root=>{
 const original=fixture();for(const format of ['sng','zip']){
  const output=path.join(root,'chosen.'+format),result=await downloadEnchor({request,format,outputPath:output,fetcher:async()=>response(original.bytes)});assert.equal(result.destination,output);assert.equal(result.format,format);assert.equal(result.output,format);
  const bytes=fs.readFileSync(output);if(format==='sng'){assert.deepEqual(bytes,original.bytes);assert.equal(result.files,original.files.size);}else{const files=readZip(bytes);assert.equal(files.size,original.files.size+1);assert.equal(files.get('song.ini').toString('utf8'),original.ini);for(const [name,data]of original.files)assert.deepEqual(files.get(name),data);}
 }
 assert.deepEqual(fs.readdirSync(root).sort(),['chosen.sng','chosen.zip']);
}));
test('video opt-out filters only the recognized root background video in every mode',async()=>temporary(async root=>{
 const original=fixture();for(const format of ['folder','sng','zip']){
  const result=await downloadEnchor({request,format,includeVideo:false,directory:root,outputPath:format==='folder'?undefined:path.join(root,'without-video.'+format),fetcher:async()=>response(original.bytes)});
  const files=format==='zip'?readZip(fs.readFileSync(result.destination)):format==='sng'?decodeSng(fs.readFileSync(result.destination)):new Map([...original.files.keys(),'song.ini'].filter(name=>fs.existsSync(path.join(result.destination,...name.split('/')))).map(name=>[name,fs.readFileSync(path.join(result.destination,...name.split('/')))]));
  assert.equal(files.has('video.webm'),false);for(const [name,data]of original.files)if(name!=='video.webm')assert.deepEqual(files.get(name),data);
  if(format!=='sng')assert.equal(files.get('song.ini').toString('utf8'),original.ini);
 }
}));
test('direct folder import writes notes, audio, video, extras and song.ini only after full provider validation',async()=>temporary(async root=>{
 const original=fixture(),result=await downloadEnchor({request,directory:root,fetcher:async()=>response(original.bytes)});assert.equal(result.format,'folder');assert.equal(result.files,original.files.size+1);assert.equal(result.destination,path.join(root,'Band - Song'));
 for(const [name,data]of original.files)assert.deepEqual(fs.readFileSync(path.join(result.destination,...name.split('/'))),data);assert.equal(fs.readFileSync(path.join(result.destination,'song.ini'),'utf8'),original.ini);assert.deepEqual(fs.readdirSync(root),['Band - Song']);
}));
test('archive saves preserve existing files unless overwrite was confirmed and the chosen target is unchanged',async()=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.sng');fs.writeFileSync(output,'existing');let calls=0;
 await assert.rejects(downloadEnchor({request,format:'sng',outputPath:output,fetcher:async()=>{calls++;return response(original.bytes);}}),/existe déjà/);assert.equal(calls,0);assert.equal(fs.readFileSync(output,'utf8'),'existing');
 await downloadEnchor({request,format:'sng',outputPath:output,overwriteConfirmed:true,fetcher:async()=>response(original.bytes)});assert.deepEqual(fs.readFileSync(output),original.bytes);
 await assert.rejects(downloadEnchor({request,format:'sng',outputPath:output,overwriteConfirmed:true,fetcher:async()=>{fs.writeFileSync(output,'changed while downloading');return response(original.bytes);}}),/destination a changé/);assert.equal(fs.readFileSync(output,'utf8'),'changed while downloading');assert.deepEqual(fs.readdirSync(root),['chosen.sng']);
}));
test('a new archive destination appearing during download is never overwritten',async()=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.zip');await assert.rejects(downloadEnchor({request,format:'zip',outputPath:output,overwriteConfirmed:true,fetcher:async()=>{fs.writeFileSync(output,'new unrelated file');return response(original.bytes);}}),/destination a changé/);assert.equal(fs.readFileSync(output,'utf8'),'new unrelated file');assert.deepEqual(fs.readdirSync(root),['chosen.zip']);
}));
test('invalid archive paths fail before the provider request',async()=>temporary(async root=>{
 const original=fixture();let calls=0;const fetcher=async()=>{calls++;return response(original.bytes);};
 for(const outputPath of ['relative.sng',path.join(root,'wrong.txt'),root])await assert.rejects(downloadEnchor({request,format:'sng',outputPath,fetcher}));
 assert.equal(calls,0);
}));
test('real linked archive targets fail before the provider request',async t=>temporary(async root=>{
 const original=fixture(),keep=path.join(root,'keep.sng'),linked=path.join(root,'linked.sng');fs.writeFileSync(keep,'keep');let calls=0;const fetcher=async()=>{calls++;return response(original.bytes);};
 try{fs.linkSync(keep,linked);}catch(error){if(['EPERM','ENOTSUP','EACCES'].includes(error.code)){t.skip('The sandbox filesystem forbids this real hardlink fixture.');return;}throw error;}
 await assert.rejects(downloadEnchor({request,format:'sng',outputPath:linked,overwriteConfirmed:true,fetcher}),/sans lien/);assert.equal(calls,0);assert.equal(fs.readFileSync(keep,'utf8'),'keep');
}));
test('a linked destination substituted during download is never followed or removed',async t=>temporary(async root=>{
 const original=fixture(),keep=path.join(root,'keep.sng'),output=path.join(root,'chosen.sng'),link=path.join(root,'fixture-link.sng');fs.writeFileSync(keep,'keep');
 try{fs.symlinkSync(keep,link,'file');}catch(error){if(['EPERM','ENOTSUP','EACCES'].includes(error.code)){t.skip('The sandbox filesystem forbids this real symlink fixture.');return;}throw error;}
 fs.writeFileSync(output,'existing');await assert.rejects(downloadEnchor({request,format:'sng',outputPath:output,overwriteConfirmed:true,fetcher:async()=>{fs.unlinkSync(output);fs.renameSync(link,output);return response(original.bytes);}}),/sans lien/);assert.equal(fs.lstatSync(output).isSymbolicLink(),true);assert.equal(fs.readFileSync(keep,'utf8'),'keep');assert.deepEqual(fs.readdirSync(root).sort(),['chosen.sng','keep.sng']);
}));
test('standard library ZIP readers independently verify every original member and generated song.ini',async()=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'standard.zip');await downloadEnchor({request,format:'zip',outputPath:output,fetcher:async()=>response(original.bytes)});
 let run;
 for(const command of ['python3','python']){const check=spawnSync(command,['--version'],{encoding:'utf8',windowsHide:true,timeout:5000});if(check.status===0&&/^Python 3\./.test(check.stdout||check.stderr)){run=spawnSync(command,['-c','import sys,zipfile,hashlib,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({i.filename:hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))',output],{encoding:'utf8',windowsHide:true,timeout:10000});break;}}
 if(!run&&process.platform==='win32'){
  const script="[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead($env:CHARTSHUB_TEST_ZIP); try { $hashes = @{}; foreach ($entry in $archive.Entries) { $stream = $entry.Open(); $sha = [System.Security.Cryptography.SHA256]::Create(); try { $hashes[$entry.FullName] = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() } }; $hashes | ConvertTo-Json -Compress } finally { $archive.Dispose() }";
  run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,CHARTSHUB_TEST_ZIP:output}});
 }
 assert.ok(run,'Python standard library or Windows .NET ZIP reader is required for this interoperability fixture');assert.equal(run.status,0,run.stderr);const expected={};for(const [name,data]of original.files)expected[name]=crypto.createHash('sha256').update(data).digest('hex');expected['song.ini']=crypto.createHash('sha256').update(original.ini).digest('hex');assert.deepEqual(JSON.parse(run.stdout.replace(/^\uFEFF/,'')),expected);
}));
test('cancelled archive conversion keeps an existing destination and removes only its own staging files',async()=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.zip'),controller=new AbortController();fs.writeFileSync(output,'keep');
 await assert.rejects(downloadEnchor({request,format:'zip',outputPath:output,overwriteConfirmed:true,signal:controller.signal,fetcher:async()=>response(original.bytes),progress:value=>{if(value.message==='Préparation du ZIP…')controller.abort(Error('Cancelled conversion'));}}),/Cancelled conversion/);assert.equal(fs.readFileSync(output,'utf8'),'keep');assert.deepEqual(fs.readdirSync(root),['chosen.zip']);
}));
test('cancelled publication removes only the unchanged exclusive reservation',async t=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.sng'),controller=new AbortController(),open=fs.promises.open.bind(fs.promises);fs.writeFileSync(path.join(root,'keep.txt'),'keep');
 t.mock.method(fs.promises,'open',async(filename,...args)=>{const handle=await open(filename,...args);if(filename===output)controller.abort(Error('Cancelled publication'));return handle;});
 await assert.rejects(downloadEnchor({request,format:'sng',outputPath:output,signal:controller.signal,fetcher:async()=>response(original.bytes)}),/Cancelled publication/);assert.deepEqual(fs.readdirSync(root),['keep.txt']);
}));
test('an exclusive save reservation changed before publication is preserved and never replaced',async t=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.sng'),open=fs.promises.open.bind(fs.promises);
 t.mock.method(fs.promises,'open',async(filename,...args)=>{const handle=await open(filename,...args);if(filename===output)fs.writeFileSync(output,'changed reservation');return handle;});
 await assert.rejects(downloadEnchor({request,format:'sng',outputPath:output,fetcher:async()=>response(original.bytes)}),/destination a changé/);assert.equal(fs.readFileSync(output,'utf8'),'changed reservation');assert.deepEqual(fs.readdirSync(root),['chosen.sng']);
}));
test('a complete archive stays published when cancellation arrives after its atomic rename',async t=>temporary(async root=>{
 const original=fixture(),output=path.join(root,'chosen.sng'),controller=new AbortController(),rename=fs.promises.rename.bind(fs.promises);
 t.mock.method(fs.promises,'rename',async(source,target)=>{const result=await rename(source,target);if(target===output)controller.abort();return result;});
 const result=await downloadEnchor({request,format:'sng',outputPath:output,signal:controller.signal,fetcher:async()=>response(original.bytes)});assert.equal(result.format,'sng');assert.deepEqual(fs.readFileSync(output),original.bytes);assert.deepEqual(fs.readdirSync(root),['chosen.sng']);
}));
