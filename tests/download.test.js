'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {validateManifest,endpointValid,downloadChart,ORIGIN}=require('../download');
const endpoint='/api/admin/charts/12345678-1234-1234-1234-123456789012/chartabcdefghij/download-manifest';
const entry=(name='song.ini',value='[Song]\nname=Test')=>({parts:[name],size:Buffer.byteLength(value),sha256:crypto.createHash('sha256').update(value).digest('hex'),url:endpoint.replace('download-manifest','files/fileabcdefghijk')});
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
