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
test('accepts only ChartsHub chart endpoints and safe files with an optional valid digest',()=>{
 assert.equal(endpointValid(endpoint),true);
 for(const value of ['https://evil.test/'+endpoint,endpoint+'?url=evil',endpoint.replace('/admin/charts/','/admin/users/'),endpoint+'/../x'])assert.equal(endpointValid(value),false);
 for(const parts of [['..','song.ini'],['C:','song.ini'],['CON.ini'],['desktop.ini'],['a.exe'],['song.ini '],['a\\b.ini']])assert.throws(()=>validateManifest({files:[{...entry(),parts}]},endpoint));
 assert.equal(validateManifest({files:[{...entry(),sha256:undefined}]},endpoint),entry().size);
 for(const sha256 of [null,'',false,123,{},'0'.repeat(63),'0'.repeat(65),'z'.repeat(64)])assert.throws(()=>validateManifest({files:[{...entry(),sha256}]},endpoint),/SHA-256/);
 assert.throws(()=>validateManifest({files:[null]},endpoint));
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

test('mixed modern inventories and hashed files download atomically, including videos',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-optional-hash-'));
 const values=['[Song]\nname=Modern','notes content','audio bytes','video bytes',''];
 const files=['song.ini','notes.chart','song.ogg','video.webm','readme.txt'].map((name,i)=>{const file={...entry(name,values[i]),url:endpoint.replace('download-manifest','files/fileabcdefghijk'+i)};if(i!==0)delete file.sha256;return file;});
 try{const result=await downloadChart({endpoint,directory:root,fetcher:async url=>{
  if(url.endsWith('download-manifest'))return Response.json({title:'Modern',files});
  assert.deepEqual(fs.readdirSync(root).filter(name=>!name.startsWith('.chartshub-partial-')),[]);
  return new Response(values[files.findIndex(file=>ORIGIN+file.url===url)]);
 }});assert.equal(result.files,files.length);for(let i=0;i<files.length;i++)assert.equal(fs.readFileSync(path.join(result.destination,...files[i].parts),'utf8'),values[i]);assert.deepEqual(fs.readdirSync(root),['Modern']);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('unhashed files still require exact sizes and malformed hashes stop before any file request',async()=>{
 for(const mode of ['short','long','malformed']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-inventory-failure-'));fs.writeFileSync(path.join(root,'keep.txt'),'keep');let requests=0;
  try{await assert.rejects(downloadChart({endpoint,directory:root,fetcher:async url=>{
   requests++;if(url.endsWith('download-manifest'))return Response.json({title:'Test',files:[{...entry('video.webm','data'),sha256:mode==='malformed'?'bad':undefined}]});
   return new Response(mode==='short'?'dat':'data extra');
  }}),mode==='malformed'?/SHA-256 invalide/:/Taille incorrecte/);assert.equal(requests,mode==='malformed'?1:2);assert.deepEqual(fs.readdirSync(root),['keep.txt']);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('native exports preserve every background video format offered by the site',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-video-formats-'));
 const names=['song.ini','notes.chart','song.ogg',...['mp4','webm','avi','vp8','ogv','mpeg','mpg','mov','m4v','mkv'].map(ext=>'video.'+ext)];
 const values=names.map(name=>Buffer.from('Original file bytes: '+name));
 const files=names.map((name,i)=>({...entry(name,values[i]),url:endpoint.replace('download-manifest','files/fileabcdefghijk'+i)}));
 const requested=[];
 try{
  const result=await downloadChart({endpoint,directory:root,fetcher:async url=>{
   if(url.endsWith('download-manifest'))return Response.json({title:'All video formats',files});
   const index=files.findIndex(file=>ORIGIN+file.url===url);assert.ok(index>=0);requested.push(index);return new Response(values[index]);
  }});
  assert.equal(result.files,names.length);assert.equal(requested.length,names.length);
  for(let i=0;i<names.length;i++)assert.deepEqual(fs.readFileSync(path.join(result.destination,names[i])),values[i]);
  assert.deepEqual(fs.readdirSync(root),[result.folderName]);
  for(const name of ['video.webm.exe','video.js','autorun.ini'])assert.throws(()=>validateManifest({files:[entry(name)]},endpoint),/Type de fichier non pris en charge/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('quota errors from manifest or file bodies explain the cause without retrying or exposing upstream details',async()=>{
 for(const phase of ['manifest','file']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-quota-error-'));fs.writeFileSync(path.join(root,'keep.txt'),'keep');let requests=0;
  try{await assert.rejects(downloadChart({endpoint,directory:root,fetcher:async url=>{
   requests++;if(phase==='file'&&url.endsWith('download-manifest'))return Response.json({title:'Test',files:[entry()]});
   return Response.json({code:'DRIVE_DOWNLOAD_QUOTA',error:'SECRET https://drive.test/?key=private',retryAt:'2026-09-28T12:00:00Z'},{status:502});
  }}),error=>{assert.match(error.message,/Quota de téléchargement Google Drive dépassé/);assert.doesNotMatch(error.message,/SECRET|private|scan|antivirus|HTTP 502/);assert.equal(error.code,'DRIVE_DOWNLOAD_QUOTA');assert.equal(error.retryAt,'2026-09-28T12:00:00.000Z');return true;});assert.equal(requests,phase==='manifest'?1:2);assert.deepEqual(fs.readdirSync(root),['keep.txt']);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('structured server error codes distinguish permissions, rate limits, configuration and changed files',async()=>{
 const cases=[
  ['DRIVE_PERMISSION_DENIED',/partage et ses autorisations/],['DRIVE_RATE_LIMIT',/limite temporairement les requêtes/],
  ['DRIVE_AUTH_ERROR',/configuration Google Drive du serveur/],['DRIVE_NOT_FOUND',/introuvable/],
  ['DRIVE_DOWNLOAD_RESTRICTED',/restrictions du fichier/],['DRIVE_ACCESS_DENIED',/sans préciser la cause/],
  ['DRIVE_UNAVAILABLE',/temporairement indisponible/],['CHART_FILES_CHANGED',/Actualisez Google Drive depuis le tableau de bord/],
  ['CHART_DOWNLOAD_BUSY',/Trop de téléchargements/],['CHART_DOWNLOAD_INTERRUPTED',/interrompu sur le serveur/]
 ];
 for(const [code,message] of cases)await assert.rejects(downloadChart({endpoint,directory:'unused',fetcher:async()=>Response.json({code,error:'RAW_PRIVATE_URL',retryAt:'not-a-date'},{status:502})}),error=>{assert.match(error.message,message);assert.doesNotMatch(error.message,/RAW_PRIVATE_URL|Connectez-vous|antivirus/);assert.equal(error.code,code);assert.equal(error.retryAt,undefined);return true;});
 for(const code of ['__proto__','toString','UNKNOWN'])await assert.rejects(downloadChart({endpoint,directory:'unused',fetcher:async()=>Response.json({code,error:'RAW_PRIVATE_URL'},{status:502})}),error=>{assert.match(error.message,/HTTP 502/);assert.doesNotMatch(error.message,/RAW_PRIVATE_URL/);assert.equal(error.code,undefined);return true;});
 await assert.rejects(downloadChart({endpoint,directory:'unused',fetcher:async()=>new Response('not allowed',{status:403})}),/Connectez-vous avec le compte autorisé/);
});

for(const [code,status,message] of [
 ['ARCHIVE_NOT_READY',409,/Attendez la fin de l’import et de l’analyse antivirus/],
 ['ARCHIVE_DOWNLOAD_FAILED',502,/temporairement indisponible.*support ChartsHub/],
 ['CATALOGUE_CONFLICT',409,/a changé pendant le téléchargement.*version actuelle/],
 ['ARCHIVE_INFECTED',409,/L’antivirus a bloqué cette archive.*doit corriger les fichiers/]
])test('native R2 '+code+' explains the cause at manifest and file stages without exposing server details',async()=>{
 for(const phase of ['manifest','file']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-r2-error-'));fs.writeFileSync(path.join(root,'keep.txt'),'Existing chart');let requests=0;
  try{
   await assert.rejects(downloadChart({endpoint,directory:root,fetcher:async url=>{
    requests++;if(phase==='file'&&url.endsWith('download-manifest'))return Response.json({title:'R2 chart',files:[entry()]});
    return Response.json({code,error:'SECRET https://bucket.r2.example/archive.zip?key=private',cause:{message:'UPSTREAM_SECRET',url:'https://private.example/'},retryAt:'2026-10-01T12:00:00Z'},{status});
   }}),error=>{assert.equal(error.code,code);assert.match(error.message,message);assert.doesNotMatch(error.message,/SECRET|private|r2\.example|HTTP|Connectez-vous/);assert.equal(error.cause,undefined);assert.equal(error.retryAt,undefined);if(phase==='file')assert.match(error.message,/^song\.ini : /);return true;});
   assert.equal(requests,phase==='manifest'?1:2,'a failed archive is not retried automatically');assert.deepEqual(fs.readdirSync(root),['keep.txt']);assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'Existing chart');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('oversized and malformed error bodies are cancelled and never displayed',async()=>{
 let cancelled=false,reads=0;
 const stream=new ReadableStream({pull(controller){reads++;controller.enqueue(Buffer.alloc(8192,'x'));},cancel(){cancelled=true;}},{highWaterMark:0});
 await assert.rejects(downloadChart({endpoint,directory:'unused',fetcher:async()=>new Response(stream,{status:502})}),/HTTP 502/);
 assert.equal(cancelled,true);assert.equal(reads,3);
 for(const body of ['<html>SECRET</html>','{"code":','null','"SECRET"'])await assert.rejects(downloadChart({endpoint,directory:'unused',fetcher:async()=>new Response(body,{status:502})}),error=>{assert.match(error.message,/HTTP 502/);assert.doesNotMatch(error.message,/SECRET|SyntaxError/);return true;});
});

test('error streams obey cancellation and idle timeouts in both download phases',async()=>{
 for(const phase of ['manifest','file'])for(const mode of ['idle','cancel','broken']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chartshub-error-stream-')),controller=new AbortController();fs.writeFileSync(path.join(root,'keep.txt'),'keep');let cancelled=false;
  try{await assert.rejects(downloadChart({endpoint,directory:root,signal:controller.signal,idleTimeoutMs:30,fetcher:async url=>{
   if(phase==='file'&&url.endsWith('download-manifest'))return Response.json({title:'Test',files:[entry()]});
   const stream=new ReadableStream({start(source){if(mode==='broken')source.error(new Error('SECRET error stream'));if(mode==='cancel')setTimeout(()=>controller.abort(new Error('Annulation demandée.')),5);},cancel(){cancelled=true;}});
   return new Response(stream,{status:502});
  }}),error=>{assert.match(error.message,mode==='idle'?/aucune donnée/:mode==='cancel'?/Annulation demandée/:/HTTP 502/);assert.doesNotMatch(error.message,/SECRET/);return true;});assert.deepEqual(fs.readdirSync(root),['keep.txt']);if(mode!=='broken')assert.equal(cancelled,true);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
