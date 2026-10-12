'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {idleTransfer}=require('./transfer-timeout');
const {songFolderName,validateDestination,safePart}=require('./download');
const {validateSngHeader,parseSngHeader,MAX_BYTES,MAX_FILE_BYTES,MAX_HEADER_BYTES}=require('./enchor-sng');
const {writeZipFromSng,writeFilteredSng,writeFolderFromSng}=require('./enchor-archive');
const CDN='https://files.enchor.us/';
const invalid=()=>Error('Le fichier ChorusEncore n’est pas un conteneur SNG valide.');
function normalizeEnchorRequest(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['md5','title','artist'].includes(key))
  ||!Object.hasOwn(value,'md5')||typeof value.md5!=='string'||value.md5.length!==32||!/^[a-f0-9]{32}$/i.test(value.md5))throw Error('Demande ChorusEncore invalide.');
 const result={md5:value.md5.toLowerCase()};
 for(const key of ['title','artist']){
  if(value[key]!==undefined&&(typeof value[key]!=='string'||value[key].length>200))throw Error('Métadonnées ChorusEncore invalides.');
  result[key]=(value[key]||'').replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
 }
 return result;
}
function enchorIdentity(md5){return 'enchor:'+normalizeEnchorRequest({md5}).md5;}
function normalizeEnchorDownloadRequest(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['md5','title','artist','format','includeVideo'].includes(key)))throw Error('Demande ChorusEncore invalide.');
 const request=normalizeEnchorRequest(Object.fromEntries(['md5','title','artist'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])));
 if(value.format!==undefined&&!['folder','zip','sng'].includes(value.format)||value.includeVideo!==undefined&&typeof value.includeVideo!=='boolean')throw Error('Format ChorusEncore invalide.');
 return {request,format:value.format??'folder',includeVideo:value.includeVideo!==false};
}
async function validateSng(filename,size,signal,details=false){
 const file=await fsp.open(filename,'r');
 try{
  if(!Number.isSafeInteger(size)||size<0||size>MAX_BYTES)throw invalid();const data=Buffer.alloc(Math.min(size,MAX_HEADER_BYTES));let offset=0;
  while(offset<data.length){signal?.throwIfAborted();const read=await file.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw invalid();offset+=read.bytesRead;}
  const header=(details?parseSngHeader:validateSngHeader)(data);if(!header||header.totalBytes!==size)throw invalid();return header;
 }finally{await file.close();}
}
function downloadError(status,headers){
 const error=Error(status===404?'Cette chart ChorusEncore n’est plus disponible.':status===401||status===403?'ChorusEncore refuse ce téléchargement.':status===429?'ChorusEncore limite temporairement les téléchargements. Réessayez plus tard.':'Le téléchargement ChorusEncore a échoué (HTTP '+status+'). Réessayez plus tard.');
 if(status===401||status===403)error.code='ENCHOR_DOWNLOAD_ACCESS_DENIED';
 if(status===429){error.code='ENCHOR_DOWNLOAD_RATE_LIMITED';const value=headers?.get?.('retry-after')?.trim(),server=Date.parse(headers?.get?.('date')||'');let seconds=0;if(value&&/^\d+$/.test(value))seconds=Number(value);else if(value&&Number.isFinite(Date.parse(value)))seconds=Math.max(0,Math.ceil((Date.parse(value)-(Number.isFinite(server)?server:Date.now()))/1000));if(Number.isSafeInteger(seconds)&&seconds>0){error.retryAfterSeconds=seconds;error.message+=' Attendez '+seconds+' secondes.';}}
 return error;
}
function cancelBody(response){
 // Cancellation belongs to the transport and may itself never settle. Request
 // it without holding the native job or temporary-file cleanup open forever.
 try{const cancelled=response?.body?.cancel?.();cancelled?.catch?.(()=>{});}catch{}
}
async function downloadEnchor(options){
 const request=normalizeEnchorRequest(options.request),activity=idleTransfer(options.signal,options.idleTimeoutMs??60000);
 try{return await transfer({...options,request,...activity});}finally{activity.close();}
}
async function fileSnapshot(target){
 let info;try{info=await fsp.lstat(target,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw Error('La destination doit être un fichier ordinaire, sans lien.');
 return snapshot(info);
}
function snapshot(info){return {dev:info.dev,ino:info.ino,size:info.size,mtime:info.mtimeNs,ctime:info.ctimeNs};}
function sameFile(left,right){return left===null?right===null:!!right&&Object.keys(left).every(key=>left[key]===right[key]);}
async function prepareSavePath(outputPath,format,overwriteConfirmed){
 if(typeof outputPath!=='string'||!path.isAbsolute(outputPath)||!safePart(path.basename(outputPath))||path.extname(outputPath).toLowerCase()!=='.'+format)throw Error('Choisissez un nom de fichier .'+format+' valide.');
 const root=await fsp.realpath(path.dirname(outputPath));if(!(await fsp.stat(root)).isDirectory())throw Error('Choisissez un dossier.');
 const filename=path.basename(outputPath),destination=path.join(root,filename);validateDestination(root,'',[{parts:[filename]}]);
 const snapshot=await fileSnapshot(destination);if(snapshot&&!overwriteConfirmed)throw Error('Le fichier existe déjà. Choisissez un autre nom.');
 return {root,filename,destination,snapshot};
}
async function publishSavedFile(source,save,signal){
 signal.throwIfAborted();const current=await fileSnapshot(save.destination);if(!sameFile(save.snapshot,current))throw Error('Le fichier de destination a changé. Choisissez un autre nom et réessayez.');
 let reserved,committed=false;
 try{
  if(!current){
   // Exclusive reservation works on NTFS, exFAT and filesystems without links.
   // Rename may replace only this fresh, unchanged empty file.
   const handle=await fsp.open(save.destination,'wx',0o600);try{const info=await handle.stat({bigint:true});if(info.size!==0n||info.nlink!==1n)throw Error('Le fichier de destination a changé. Choisissez un autre nom et réessayez.');reserved=snapshot(info);}finally{await handle.close();}
   signal.throwIfAborted();if(!sameFile(reserved,await fileSnapshot(save.destination)))throw Error('Le fichier de destination a changé. Choisissez un autre nom et réessayez.');
  }
  signal.throwIfAborted();await fsp.rename(source,save.destination);committed=true;
 }finally{
  if(!committed&&reserved&&sameFile(reserved,await fileSnapshot(save.destination)))await fsp.unlink(save.destination);
 }
}
async function transfer({request,directory,outputPath,format='folder',includeVideo=true,overwriteConfirmed=false,fetcher,signal,wait,touch,progress=()=>{}}){
 if(typeof fetcher!=='function')throw Error('Téléchargement ChorusEncore indisponible.');
 if(!['folder','zip','sng'].includes(format)||typeof includeVideo!=='boolean'||typeof overwriteConfirmed!=='boolean')throw Error('Format ChorusEncore invalide.');
 signal.throwIfAborted();const save=format==='folder'?null:await prepareSavePath(outputPath,format,overwriteConfirmed),root=save?.root||await fsp.realpath(directory);if(!(await fsp.stat(root)).isDirectory())throw Error('Choisissez un dossier.');
 const base=songFolderName(request);validateDestination(root,'',[{parts:[base+'.sng']}]);
 const staging=await fsp.mkdtemp(path.join(root,'.chartshub-partial-')),target=path.join(staging,'chart.sng');let response,reserved,committed=false;
 try{
  const url=CDN+request.md5+'.sng';progress({message:'Préparation du téléchargement ChorusEncore…',percent:0});
  const fetching=Promise.resolve(fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal,headers:{Accept:'application/octet-stream','Accept-Encoding':'identity'}}));
  // A transport that ignores AbortSignal can still deliver headers after the
  // idle deadline. Close that late response even though the job already ended.
  fetching.then(reply=>{if(signal.aborted)cancelBody(reply);},()=>{});
  response=await wait(fetching);
  if(response?.status!==200)throw downloadError(Number.isInteger(response?.status)?response.status:503,response?.headers);
  if(response.redirected||(response.url&&response.url!==url)||!response.body)throw Error('Réponse ChorusEncore invalide.');
  const encoding=(response.headers?.get('content-encoding')||'').trim().toLowerCase();if(encoding&&encoding!=='identity')throw Error('Encodage du téléchargement ChorusEncore non pris en charge.');
  const declared=response.headers?.get('content-length');let expected=null;
  if(declared!==null&&declared!==undefined){if(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>MAX_BYTES)throw Error('La chart ChorusEncore dépasse la limite de 4 Go ou sa taille est invalide.');expected=Number(declared);if(expected<50)throw invalid();}
  let bytes=0,last=0;
  const verify=new Transform({transform(chunk,_encoding,done){touch();bytes+=chunk.length;if(bytes>MAX_BYTES||(expected!==null&&bytes>expected))return done(Error('Taille du téléchargement ChorusEncore invalide ou supérieure à 4 Go.'));if(Date.now()-last>200){last=Date.now();progress({message:'Téléchargement ChorusEncore…',percent:expected?Math.min(99,Math.floor(bytes/expected*100)):0});}done(null,chunk);}});
  await wait(pipeline(Readable.fromWeb(response.body),verify,fs.createWriteStream(target,{flags:'wx',mode:0o600}),{signal}));
  if(expected!==null&&bytes!==expected)throw Error('Le téléchargement ChorusEncore est incomplet.');
  signal.throwIfAborted();progress({message:'Vérification du conteneur SNG…',percent:99});const checked=await wait(validateSng(target,bytes,signal,format!=='sng'||!includeVideo));touch();
  let prepared=target,result={files:checked.files,format:'sng'};
  if(format==='folder'){
   prepared=path.join(staging,'prepared-folder');validateDestination(root,base,checked.members.map(member=>({parts:member.parts})).concat([{parts:['song.ini']}]));
   progress({message:'Importation des fichiers de la chart…',percent:99});
   result=await writeFolderFromSng({sourceFile:target,header:checked,outputDirectory:prepared,signal,touch,includeVideo,progress:()=>touch()});
  }else if(format==='zip'||!includeVideo){
   prepared=path.join(staging,'prepared.'+(format==='zip'?'zip':'sng'));progress({message:format==='zip'?'Préparation du ZIP…':'Préparation du SNG sans vidéo…',percent:99});
   const convert=format==='zip'?writeZipFromSng:writeFilteredSng;
   result=await convert({sourceFile:target,header:checked,outputFile:prepared,signal,touch,includeVideo,progress:()=>touch()});
  }
  if(save){
   await publishSavedFile(prepared,save,signal);committed=true;
   progress({message:'Téléchargement terminé : '+save.filename,percent:100});return {...result,fileName:save.filename,folderName:save.filename,destination:save.destination,output:format};
  }
  let folderName,destination;
  // Reserve a fresh directory, then publish only this operation's fully verified
  // and decoded files. No existing chart is replaced.
  for(let n=1;;n++){
   signal.throwIfAborted();folderName=base+(n===1?'':` (${n})`);validateDestination(root,folderName,checked.members.map(member=>({parts:member.parts})).concat([{parts:['song.ini']}]));reserved=path.join(root,folderName);
   try{await fsp.mkdir(reserved,{mode:0o700});break;}catch(error){reserved=null;if(error.code!=='EEXIST')throw error;}
  }
  signal.throwIfAborted();destination=reserved;
  for(const name of await fsp.readdir(prepared)){signal.throwIfAborted();await fsp.rename(path.join(prepared,name),path.join(reserved,name));}
  committed=true;
  progress({message:'Téléchargement terminé : '+folderName,percent:100});return {folderName,destination,files:result.files,format:'folder',output:'folder'};
 }finally{
  cancelBody(response);
  // Remove only this operation's freshly created child of the resolved root.
  if(path.dirname(staging)===root&&path.basename(staging).startsWith('.chartshub-partial-'))await fsp.rm(staging,{recursive:true,force:true});
  if(!committed&&reserved&&path.dirname(reserved)===root)await fsp.rm(reserved,{recursive:true,force:true});
 }
}
module.exports={normalizeEnchorRequest,normalizeEnchorDownloadRequest,enchorIdentity,validateSngHeader,validateSng,downloadEnchor,downloadError,MAX_BYTES,MAX_FILE_BYTES};
