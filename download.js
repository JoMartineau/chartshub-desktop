'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const ORIGIN='https://chartshub.ca',LIMIT=2000000000;
function endpointValid(endpoint){return typeof endpoint==='string'&&/^\/api\/(?:admin\/)?charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/.test(endpoint);}
function safePart(value){return typeof value==='string'&&value.length>0&&value.length<=150&&!/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value)&&!/[. ]$/.test(value)&&!/^(?:\.{1,2}|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);}
function validateManifest(manifest,endpoint){
 if(!endpointValid(endpoint)||!Array.isArray(manifest?.files)||!manifest.files.length||manifest.files.length>1000)throw Error('Liste des fichiers invalide.');
 let total=0;const paths=new Set(),prefix=endpoint.replace(/download-manifest$/,'files/');
 for(const file of manifest.files){
  if(!Array.isArray(file.parts)||!file.parts.length||file.parts.length>6||!file.parts.every(safePart)||file.parts.join('/').length>200||!Number.isSafeInteger(file.size)||file.size<0||typeof file.url!=='string'||!file.url.startsWith(prefix)||!/^[A-Za-z0-9_-]{10,200}$/.test(file.url.slice(prefix.length))||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw Error('Fichier invalide ou non analysé. Relancez le scan antivirus.');
  const name=file.parts.at(-1);
  if(!/\.(?:ini|chart|mid|midi|ogg|opus|mp3|wav|flac|aiff|aif|m4a|png|jpg|jpeg|webp|bmp|gif|mp4|webm|avi|mkv|txt|json)$/i.test(name)||(/\.ini$/i.test(name)&&name.toLowerCase()!=='song.ini'))throw Error('Type de fichier non pris en charge : '+name);
  const key=file.parts.join('/').toLowerCase();if(paths.has(key))throw Error('Noms de fichiers en double.');paths.add(key);
  total+=file.size;if(total>LIMIT)throw Error('La chart dépasse la limite de 2 Go.');
 }
 for(const key of paths){const parts=key.split('/');parts.pop();while(parts.length){if(paths.has(parts.join('/')))throw Error('Chemins de fichiers incompatibles.');parts.pop();}}
 return total;
}
async function readJson(response){
 if(!response.ok)throw Error(response.status===401||response.status===403?'Connectez-vous avec le compte autorisé dans l’application.':'Le serveur a refusé le téléchargement (HTTP '+response.status+').');
 const reader=response.body.getReader();let total=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>2000000)throw Error('Réponse du serveur trop volumineuse.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function downloadChart({endpoint,directory,fetcher,signal,progress=()=>{}}){
 if(!endpointValid(endpoint))throw Error('Lien ChartsHub invalide.');
 const options={credentials:'include',redirect:'error',cache:'no-store',signal};
 progress({message:'Préparation du téléchargement…',percent:0});
 const manifest=await readJson(await fetcher(ORIGIN+endpoint,options));
 const total=validateManifest(manifest,endpoint);
 signal?.throwIfAborted();
 const root=await fsp.realpath(directory);
 const info=await fsp.stat(root);if(!info.isDirectory())throw Error('Choisissez un dossier.');
 const prefix=path.join(root,'.chartshub-partial-');
 const staging=await fsp.mkdtemp(prefix);let committed=false,saved=0,lastProgress=0;
 try{
  const files=[...manifest.files].sort((a,b)=>Number(!/\.(ini|chart|mid)$/i.test(a.parts.at(-1)))-Number(!/\.(ini|chart|mid)$/i.test(b.parts.at(-1)))||a.size-b.size);
  for(const file of files){
   signal?.throwIfAborted();const name=file.parts.join('/');progress({message:'Vérification et téléchargement : '+name,percent:total?Math.floor(saved/total*100):0});
   const response=await fetcher(ORIGIN+file.url,options);
   if(!response.ok||!response.body)throw Error('Téléchargement refusé pour '+name+' (HTTP '+response.status+'). Relancez le scan si le fichier a changé.');
   const target=path.resolve(staging,...file.parts);if(!target.startsWith(staging+path.sep))throw Error('Chemin interdit.');
   await fsp.mkdir(path.dirname(target),{recursive:true});const hash=crypto.createHash('sha256');let bytes=0;
   const verify=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>file.size)return done(Error('Taille incorrecte : '+name));hash.update(chunk);if(Date.now()-lastProgress>200){lastProgress=Date.now();progress({message:'Téléchargement : '+name,percent:total?Math.floor((saved+bytes)/total*100):100});}done(null,chunk);}});
   await pipeline(Readable.fromWeb(response.body),verify,fs.createWriteStream(target,{flags:'wx',mode:0o600}),{signal});
   if(bytes!==file.size||hash.digest('hex')!==file.sha256)throw Error('Le fichier ne correspond plus au scan antivirus : '+name);
   saved+=bytes;
  }
  signal?.throwIfAborted();
  const title=String(manifest.title||'Chart').replace(/<[^>]*>/g,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,60)||'Chart';
  const folderName=(endpoint.includes('/admin/')?'ChartsHub-review - ':'ChartsHub - ')+title+' - '+crypto.randomUUID();
  const destination=path.join(root,folderName);
  await fsp.rename(staging,destination);committed=true;
  progress({message:'Téléchargement terminé : '+folderName,percent:100});
  return {folderName,destination,files:manifest.files.length};
 }finally{
  // Only remove this operation's freshly created, verified child of the chosen root.
  if(!committed&&path.dirname(staging)===root&&path.basename(staging).startsWith('.chartshub-partial-'))await fsp.rm(staging,{recursive:true,force:true});
 }
}
module.exports={ORIGIN,endpointValid,safePart,validateManifest,downloadChart};
