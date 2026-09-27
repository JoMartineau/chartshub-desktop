'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {validateManifest,endpointValid,downloadChart,ORIGIN}=require('../download');
const endpoint='/api/admin/charts/12345678-1234-1234-1234-123456789012/chartabcdefghij/download-manifest';
const entry=(name='song.ini',value='[Song]\nname=Test')=>({parts:[name],size:Buffer.byteLength(value),sha256:crypto.createHash('sha256').update(value).digest('hex'),url:endpoint.replace('download-manifest','files/fileabcdefghijk')});
test('song folders use artist and title, sanitize paths, and support older manifests',()=>{
 const {songFolderName}=require('../download');
 assert.equal(songFolderName({artist:'FALLING IN REVERSE',title:'Joseph'}),'FALLING IN REVERSE - Joseph');
 assert.equal(songFolderName({title:'Song'},'[song]\nartist = Band\n'),'Band - Song');
 assert.equal(songFolderName({artist:'<color=red>Band</color>',title:'A/B: C?'}),'Band - A_B_ C_');
 assert.equal(songFolderName({title:'CON'}),'_CON');
});
test('repeated downloads preserve the original and add a numeric suffix',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-name-test-')),data='[Song]\nname=Test';
 try{const options={endpoint,directory:root,signal:new AbortController().signal,fetcher:async url=>url.endsWith('download-manifest')?Response.json({artist:'Band',title:'Song',files:[entry()]}):new Response(data)};
 const first=await downloadChart(options),second=await downloadChart(options);assert.equal(first.folderName,'Band - Song');assert.equal(second.folderName,'Band - Song (2)');assert.equal(fs.readFileSync(path.join(first.destination,'song.ini'),'utf8'),data);assert.deepEqual(fs.readdirSync(root).sort(),['Band - Song','Band - Song (2)']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('accepts only ChartsHub chart endpoints and safe scanned files',()=>{
 assert.equal(endpointValid(endpoint),true);
 for(const value of ['https://evil.test/'+endpoint,endpoint+'?url=evil',endpoint.replace('/admin/charts/','/admin/users/'),endpoint+'/../x'])assert.equal(endpointValid(value),false);
 for(const parts of [['..','song.ini'],['C:','song.ini'],['CON.ini'],['desktop.ini'],['a.exe'],['song.ini '],['a\\b.ini']])assert.throws(()=>validateManifest({files:[{...entry(),parts}]},endpoint));
 assert.throws(()=>validateManifest({files:[{...entry(),sha256:undefined}]},endpoint));
 assert.throws(()=>validateManifest({files:[entry(),entry('SONG.INI')]},endpoint));
 assert.throws(()=>validateManifest({files:[{...entry(),size:2000000001}]},endpoint));
});
test('native download writes song.ini and publishes the directory only after hash validation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-native-test-'));const progress=[];const data='[Song]\nname=Test';
 try{const result=await downloadChart({endpoint,directory:root,signal:new AbortController().signal,progress:p=>progress.push(p),fetcher:async(url,options)=>{assert.ok(url.startsWith(ORIGIN+'/api/admin/charts/'));assert.equal(options.redirect,'error');return url.endsWith('download-manifest')?Response.json({title:'Test song',files:[entry()]}):new Response(data);}});
 assert.equal(fs.readFileSync(path.join(result.destination,'song.ini'),'utf8'),data);assert.equal(result.files,1);assert.equal(progress.at(-1).percent,100);assert.deepEqual(fs.readdirSync(root),[result.folderName]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('mismatched bytes, refusal and cancellation clean only the new staging directory',async()=>{
 for(const mode of ['hash','http','cancel','size']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-failed-test-'));fs.writeFileSync(path.join(root,'keep.txt'),'keep');const controller=new AbortController();
 try{await assert.rejects(downloadChart({endpoint,directory:root,signal:controller.signal,fetcher:async url=>{
 if(url.endsWith('download-manifest'))return Response.json({title:'Test',files:[entry()]});
 if(mode==='cancel'){controller.abort();controller.signal.throwIfAborted();}if(mode==='http')return new Response('denied',{status:403});return new Response(mode==='hash'?'[Song]\nname=Evil':'short');}}));assert.deepEqual(fs.readdirSync(root),['keep.txt']);assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'keep');}
 finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('published long names and deep safe paths follow the server manifest contract',async()=>{
 const {safePart,validateDestination}=require('../download'),name='a'.repeat(151)+'.ogg';assert.equal(safePart(name),true);assert.equal(safePart('é'.repeat(128)),false);assert.equal(safePart('bad\x7fname'),false);
 assert.equal(validateManifest({files:[{...entry(name,'data'),parts:['b'.repeat(180),name]}]},endpoint),4);
 assert.throws(()=>validateDestination('C:\\'+'x'.repeat(32700),'Song',[entry(name)],'win32'),/destination trop long/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-long-name-'));
 try{const result=await downloadChart({endpoint,directory:root,signal:new AbortController().signal,fetcher:async url=>url.endsWith('download-manifest')?Response.json({title:'T'.repeat(140),files:[entry(name,'data')]}):new Response('data')});assert.equal(fs.readFileSync(path.join(result.destination,name),'utf8'),'data');}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('stalled manifest and file body time out, cancel streams and clean partial directories',async()=>{
 for(const phase of ['manifest','body']){const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-stall-'));let cancelled=false;
  try{await assert.rejects(downloadChart({endpoint,directory:root,idleTimeoutMs:30,signal:new AbortController().signal,fetcher:async url=>phase==='manifest'?new Promise(()=>{}):url.endsWith('download-manifest')?Response.json({title:'Test',files:[entry()]}):new Response(new ReadableStream({cancel(){cancelled=true;}}))}),/aucune donnée/);assert.deepEqual(fs.readdirSync(root),[]);if(phase==='body')assert.equal(cancelled,true);}finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('ongoing file activity resets the idle deadline instead of limiting total duration',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-active-')),value='abcdefgh';
 try{const result=await downloadChart({endpoint,directory:root,idleTimeoutMs:80,signal:new AbortController().signal,fetcher:async url=>url.endsWith('download-manifest')?Response.json({title:'Test',files:[entry('guitar.ogg',value)]}):new Response(new ReadableStream({start(controller){let index=0;const timer=setInterval(()=>{controller.enqueue(Buffer.from(value[index++]));if(index===value.length){clearInterval(timer);controller.close();}},20);}}))});assert.equal(fs.readFileSync(path.join(result.destination,'guitar.ogg'),'utf8'),value);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
