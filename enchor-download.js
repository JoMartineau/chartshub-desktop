'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {idleTransfer}=require('./transfer-timeout');
const {songFolderName,validateDestination}=require('./download');
const {validateSngHeader,MAX_BYTES,MAX_FILE_BYTES,MAX_HEADER_BYTES}=require('./enchor-sng');
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
async function validateSng(filename,size,signal){
 const file=await fsp.open(filename,'r');
 try{
  if(!Number.isSafeInteger(size)||size<0||size>MAX_BYTES)throw invalid();const data=Buffer.alloc(Math.min(size,MAX_HEADER_BYTES));let offset=0;
  while(offset<data.length){signal?.throwIfAborted();const read=await file.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw invalid();offset+=read.bytesRead;}
  const header=validateSngHeader(data);if(!header||header.totalBytes!==size)throw invalid();return header;
 }finally{await file.close();}
}
function downloadError(status){
 return Error(status===404?'Cette chart ChorusEncore n’est plus disponible.':status===401||status===403?'ChorusEncore refuse ce téléchargement.':status===429?'ChorusEncore limite temporairement les téléchargements. Réessayez plus tard.':'Le téléchargement ChorusEncore a échoué (HTTP '+status+'). Réessayez plus tard.');
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
async function transfer({request,directory,fetcher,signal,wait,touch,progress=()=>{}}){
 if(typeof fetcher!=='function')throw Error('Téléchargement ChorusEncore indisponible.');
 signal.throwIfAborted();const root=await fsp.realpath(directory);if(!(await fsp.stat(root)).isDirectory())throw Error('Choisissez un dossier.');
 const base=songFolderName(request);validateDestination(root,'',[{parts:[base+'.sng']}]);
 const staging=await fsp.mkdtemp(path.join(root,'.chartshub-partial-')),target=path.join(staging,'chart.sng');let response,reserved,committed=false;
 try{
  const url=CDN+request.md5+'.sng';progress({message:'Préparation du téléchargement ChorusEncore…',percent:0});
  const fetching=Promise.resolve(fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal,headers:{Accept:'application/octet-stream','Accept-Encoding':'identity'}}));
  // A transport that ignores AbortSignal can still deliver headers after the
  // idle deadline. Close that late response even though the job already ended.
  fetching.then(reply=>{if(signal.aborted)cancelBody(reply);},()=>{});
  response=await wait(fetching);
  if(response?.status!==200)throw downloadError(Number.isInteger(response?.status)?response.status:503);
  if(response.redirected||(response.url&&response.url!==url)||!response.body)throw Error('Réponse ChorusEncore invalide.');
  const encoding=(response.headers?.get('content-encoding')||'').trim().toLowerCase();if(encoding&&encoding!=='identity')throw Error('Encodage du téléchargement ChorusEncore non pris en charge.');
  const declared=response.headers?.get('content-length');let expected=null;
  if(declared!==null&&declared!==undefined){if(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>MAX_BYTES)throw Error('La chart ChorusEncore dépasse la limite de 4 Go ou sa taille est invalide.');expected=Number(declared);if(expected<50)throw invalid();}
  let bytes=0,last=0;
  const verify=new Transform({transform(chunk,_encoding,done){touch();bytes+=chunk.length;if(bytes>MAX_BYTES||(expected!==null&&bytes>expected))return done(Error('Taille du téléchargement ChorusEncore invalide ou supérieure à 4 Go.'));if(Date.now()-last>200){last=Date.now();progress({message:'Téléchargement ChorusEncore…',percent:expected?Math.min(99,Math.floor(bytes/expected*100)):0});}done(null,chunk);}});
  await wait(pipeline(Readable.fromWeb(response.body),verify,fs.createWriteStream(target,{flags:'wx',mode:0o600}),{signal}));
  if(expected!==null&&bytes!==expected)throw Error('Le téléchargement ChorusEncore est incomplet.');
  signal.throwIfAborted();progress({message:'Vérification du conteneur SNG…',percent:99});const checked=await wait(validateSng(target,bytes,signal));touch();
  let folderName,destination;const fileName=base+'.sng';
  // Reserve a fresh song directory atomically, as the native chart downloader
  // does. Clone Hero discovers this complete SNG inside the selected Songs tree.
  for(let n=1;;n++){
   signal.throwIfAborted();folderName=base+(n===1?'':` (${n})`);validateDestination(root,folderName,[{parts:[fileName]}]);reserved=path.join(root,folderName);
   try{await fsp.mkdir(reserved,{mode:0o700});break;}catch(error){reserved=null;if(error.code!=='EEXIST')throw error;}
  }
  destination=path.join(reserved,fileName);await fsp.rename(target,destination);committed=true;
  progress({message:'Téléchargement terminé : '+folderName,percent:100});return {folderName,fileName,destination,files:checked.files,format:'sng'};
 }finally{
  cancelBody(response);
  // Remove only this operation's freshly created child of the resolved root.
  if(path.dirname(staging)===root&&path.basename(staging).startsWith('.chartshub-partial-'))await fsp.rm(staging,{recursive:true,force:true});
  if(!committed&&reserved&&path.dirname(reserved)===root)await fsp.rm(reserved,{recursive:true,force:true});
 }
}
module.exports={normalizeEnchorRequest,enchorIdentity,validateSngHeader,validateSng,downloadEnchor,MAX_BYTES,MAX_FILE_BYTES};
