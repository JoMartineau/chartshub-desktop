'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {idleTransfer}=require('./transfer-timeout');
const ORIGIN='https://chartshub.ca',LIMIT=2000000000;
function endpointValid(endpoint){return typeof endpoint==='string'&&/^\/api\/(?:admin\/)?charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/.test(endpoint);}
// Manifest contract: up to six components, each <=180 UTF-16 units /255 UTF-8 bytes.
function safePart(value){return typeof value==='string'&&value.length>0&&value.length<=180&&Buffer.byteLength(value,'utf8')<=255&&!/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value)&&!/[. ]$/.test(value)&&!/^(?:\.{1,2}|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);}
function songFolderName(manifest,ini=''){
 const field=key=>ini.match(new RegExp('^\\s*'+key+'\\s*=\\s*(.*?)\\s*$','im'))?.[1]||'';
 const clean=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').trim().replace(/[. ]+$/,'');
 const artist=clean(manifest.artist||field('artist')),title=clean(manifest.title||field('name'))||'Chart';
 let name=(artist?artist+' - ':'')+title;name=Array.from(name).slice(0,140).join('').replace(/[. ]+$/,'');
 while(Buffer.byteLength(name,'utf8')>240)name=Array.from(name).slice(0,-1).join('');
 if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))name='_'+name;
 return name||'Chart';
}
function validateManifest(manifest,endpoint){
 if(!endpointValid(endpoint)||!Array.isArray(manifest?.files)||!manifest.files.length||manifest.files.length>1000)throw Error('Liste des fichiers invalide.');
 let total=0;const paths=new Set(),prefix=endpoint.replace(/download-manifest$/,'files/');
 for(const file of manifest.files){
  if(!Array.isArray(file?.parts)||!file.parts.length||file.parts.length>6||!file.parts.every(safePart))throw Error('Nom ou chemin de fichier non pris en charge. Renommez le fichier ou les dossiers.');
  if(!Number.isSafeInteger(file.size)||file.size<0||typeof file.url!=='string'||!file.url.startsWith(prefix)||!/^[A-Za-z0-9_-]{10,200}$/.test(file.url.slice(prefix.length)))throw Error('Informations de téléchargement invalides. Actualisez la chart puis réessayez.');
  if(file.sha256!==undefined&&(typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)))throw Error('Empreinte SHA-256 invalide. Actualisez la chart puis réessayez.');
  const name=file.parts.at(-1);
  if(!/\.(?:ini|chart|mid|midi|ogg|opus|mp3|wav|flac|aiff|aif|m4a|png|jpg|jpeg|webp|bmp|gif|mp4|webm|avi|vp8|ogv|mpeg|mpg|mov|m4v|mkv|txt|json)$/i.test(name)||(/\.ini$/i.test(name)&&name.toLowerCase()!=='song.ini'))throw Error('Type de fichier non pris en charge : '+name);
  const key=file.parts.join('/').toLowerCase();if(paths.has(key))throw Error('Noms de fichiers en double.');paths.add(key);
  total+=file.size;if(total>LIMIT)throw Error('La chart dépasse la limite de 2 Go.');
 }
 for(const key of paths){const parts=key.split('/');parts.pop();while(parts.length){if(paths.has(parts.join('/')))throw Error('Chemins de fichiers incompatibles.');parts.pop();}}
 return total;
}
function validateDestination(root,folder,files,platform=process.platform){
 const join=platform==='win32'?path.win32.join:path.posix.join;
 for(const file of files){const destination=join(root,folder,...file.parts),length=platform==='win32'?destination.length:Buffer.byteLength(destination,'utf8');if(length>(platform==='win32'?32700:4095))throw Error('Chemin de destination trop long. Choisissez un dossier d’exportation plus court.');}
}
const DOWNLOAD_ERRORS=Object.freeze({
 DRIVE_DOWNLOAD_QUOTA:'Quota de téléchargement Google Drive dépassé. Réessayez plus tard ; actualiser le dossier ne débloque pas ce quota.',
 DRIVE_RATE_LIMIT:'Google Drive limite temporairement les requêtes. Réessayez plus tard.',
 DRIVE_AUTH_ERROR:'La configuration Google Drive du serveur doit être corrigée par un administrateur.',
 DRIVE_PERMISSION_DENIED:'Google Drive refuse l’accès au fichier. Le propriétaire doit vérifier son partage et ses autorisations.',
 DRIVE_NOT_FOUND:'Le fichier est introuvable ou n’est plus accessible sur Google Drive.',
 DRIVE_DOWNLOAD_RESTRICTED:'Google Drive interdit ce téléchargement. Le propriétaire doit vérifier les restrictions du fichier.',
 DRIVE_ACCESS_DENIED:'Google Drive refuse cette requête sans préciser la cause. Réessayez plus tard ou contactez un administrateur.',
 DRIVE_UNAVAILABLE:'Google Drive est temporairement indisponible. Réessayez plus tard.',
 ARCHIVE_NOT_READY:'L’archive n’est pas encore prête. Attendez la fin de l’import et de l’analyse antivirus, puis actualisez la page.',
 ARCHIVE_DOWNLOAD_FAILED:'L’archive est temporairement indisponible. Réessayez le téléchargement. Si le problème persiste, contactez le support ChartsHub.',
 CATALOGUE_CONFLICT:'La chart ou son archive a changé pendant le téléchargement. Actualisez la page, puis réessayez avec la version actuelle.',
 ARCHIVE_INFECTED:'L’antivirus a bloqué cette archive. Le téléchargement et la publication sont désactivés ; le charter doit corriger les fichiers concernés.',
 CHART_FILES_CHANGED:'Les fichiers ont changé depuis la dernière synchronisation. Actualisez Google Drive depuis le tableau de bord, puis réessayez.',
 CHART_DOWNLOAD_BUSY:'Trop de téléchargements sont en cours. Réessayez dans un moment.',
 CHART_MANIFEST_FAILED:'La liste des fichiers ne peut pas être préparée. Réessayez plus tard ou contactez un administrateur.',
 CHART_DOWNLOAD_FAILED:'Le serveur ne peut pas télécharger ce fichier pour le moment. Réessayez plus tard.',
 CHART_DOWNLOAD_INTERRUPTED:'Le téléchargement a été interrompu sur le serveur. Réessayez plus tard.'
});
async function readBody(response,{wait,touch},limit){
 if(!response.body)throw Error('Réponse du serveur vide.');
 const reader=response.body.getReader();let total=0;const chunks=[];
 try{for(;;){const {done,value}=await wait(reader.read());if(done)break;touch();total+=value.length;if(total>limit)throw Error('Réponse du serveur trop volumineuse.');chunks.push(Buffer.from(value));}}finally{void reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks).toString('utf8');
}
async function downloadFailure(response,activity,name=''){
 let body;
 try{body=JSON.parse(await readBody(response,activity,16384));}catch{activity.signal?.throwIfAborted();}
 const code=typeof body?.code==='string'&&Object.hasOwn(DOWNLOAD_ERRORS,body.code)?body.code:null;
 const fallback=response.status===401||response.status===403?'Connectez-vous avec le compte autorisé dans l’application.':response.status===404?'Cette chart ou ce fichier n’est plus disponible.':response.status===429?'Trop de requêtes sont en cours. Réessayez dans un moment.':'Le serveur a refusé le téléchargement (HTTP '+response.status+'). Réessayez plus tard.';
 // Never display the raw upstream error, which can contain private URLs or credentials.
 const error=Error((name?name+' : ':'')+(code?DOWNLOAD_ERRORS[code]:fallback));
 if(code)error.code=code;
 if(code==='DRIVE_DOWNLOAD_QUOTA'&&typeof body.retryAt==='string'&&Number.isFinite(Date.parse(body.retryAt)))error.retryAt=new Date(body.retryAt).toISOString();
 return error;
}
async function readJson(response,activity){
 if(!response.ok)throw await downloadFailure(response,activity);
 const body=await readBody(response,activity,2000000);
 try{return JSON.parse(body);}catch{throw Error('Liste des fichiers illisible. Actualisez la chart puis réessayez.');}
}
async function downloadChart(options){const activity=idleTransfer(options.signal,options.idleTimeoutMs??60000);try{return await transferChart({...options,signal:activity.signal,wait:activity.wait,touch:activity.touch});}finally{activity.close();}}
async function transferChart({endpoint,directory,fetcher,signal,wait,touch,progress=()=>{},idleTimeoutMs,headerTimeoutMs=idleTimeoutMs??1800000}){
 if(!endpointValid(endpoint))throw Error('Lien ChartsHub invalide.');
 const options={credentials:'include',redirect:'error',cache:'no-store',signal};
 progress({message:'Préparation du téléchargement…',percent:0});
 const manifest=await readJson(await wait(fetcher(ORIGIN+endpoint,options)),{wait,touch,signal});
 const total=validateManifest(manifest,endpoint);
 signal?.throwIfAborted();
 const root=await fsp.realpath(directory);
 const info=await fsp.stat(root);if(!info.isDirectory())throw Error('Choisissez un dossier.');
 validateDestination(root,songFolderName(manifest),manifest.files);
 validateDestination(root,'.chartshub-partial-XXXXXXXXXXXX',manifest.files);
 const prefix=path.join(root,'.chartshub-partial-');
 const staging=await fsp.mkdtemp(prefix);let committed=false,saved=0,lastProgress=0,reserved;
 try{
  const files=[...manifest.files].sort((a,b)=>Number(!/\.(ini|chart|mid)$/i.test(a.parts.at(-1)))-Number(!/\.(ini|chart|mid)$/i.test(b.parts.at(-1)))||a.size-b.size);
  for(const file of files){
   signal?.throwIfAborted();const name=file.parts.join('/');progress({message:'Vérification et téléchargement : '+name,percent:total?Math.floor(saved/total*100):0});
   // The server prepares the whole file before releasing headers; allow its bounded transfer window.
   touch(headerTimeoutMs);const response=await wait(fetcher(ORIGIN+file.url,options));touch();
   if(!response.ok)throw await downloadFailure(response,{wait,touch,signal},name);
   if(!response.body)throw Error('Réponse du serveur vide : '+name);
   const target=path.resolve(staging,...file.parts);if(!target.startsWith(staging+path.sep))throw Error('Chemin interdit.');
   await fsp.mkdir(path.dirname(target),{recursive:true});const hash=file.sha256===undefined?null:crypto.createHash('sha256');let bytes=0;
   const verify=new Transform({transform(chunk,encoding,done){touch();bytes+=chunk.length;if(bytes>file.size)return done(Error('Taille incorrecte : '+name));hash?.update(chunk);if(Date.now()-lastProgress>200){lastProgress=Date.now();progress({message:'Téléchargement : '+name,percent:total?Math.floor((saved+bytes)/total*100):100});}done(null,chunk);}});
   await wait(pipeline(Readable.fromWeb(response.body),verify,fs.createWriteStream(target,{flags:'wx',mode:0o600}),{signal}));
   if(bytes!==file.size)throw Error('Taille incorrecte : '+name);
   if(hash&&hash.digest('hex')!==file.sha256)throw Error('L’empreinte SHA-256 du fichier téléchargé ne correspond pas : '+name);
   saved+=bytes;
  }
  signal?.throwIfAborted();
  let ini='';const iniFile=manifest.files.find(f=>f.parts.length===1&&f.parts[0].toLowerCase()==='song.ini');
  if(iniFile&&!manifest.artist){const handle=await fsp.open(path.join(staging,...iniFile.parts),'r');try{const buffer=Buffer.alloc(65536);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);ini=buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}}
  const base=songFolderName(manifest,ini);let folderName,destination;
  for(let n=1;;n++){signal?.throwIfAborted();folderName=base+(n===1?'':` (${n})`);validateDestination(root,folderName,manifest.files);destination=path.join(root,folderName);try{await fsp.mkdir(destination,{mode:0o700});reserved=destination;break;}catch(error){if(error.code!=='EEXIST')throw error;}}
  // Reserve a fresh directory atomically so an existing song is never replaced.
  for(const entry of await fsp.readdir(staging))await fsp.rename(path.join(staging,entry),path.join(destination,entry));
  committed=true;
  progress({message:'Téléchargement terminé : '+folderName,percent:100});
  return {folderName,destination,files:manifest.files.length};
 }finally{
  // Only remove this operation's freshly created, verified child of the chosen root.
  if(path.dirname(staging)===root&&path.basename(staging).startsWith('.chartshub-partial-'))await fsp.rm(staging,{recursive:true,force:true});
  if(!committed&&reserved&&path.dirname(reserved)===root)await fsp.rm(reserved,{recursive:true,force:true});
 }
}
module.exports={ORIGIN,endpointValid,safePart,validateManifest,validateDestination,downloadChart,songFolderName};
