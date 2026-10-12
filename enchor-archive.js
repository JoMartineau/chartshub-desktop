'use strict';
// SNG v1 masks each file from its own zero offset. ZIP output contains decoded
// original members and a song.ini reconstructed from the SNG metadata.
const fs=require('node:fs').promises,path=require('node:path');
const {MAX_BYTES,encodeSongIni,selectSngMembers,buildSngHeader}=require('./enchor-sng');
const CHUNK_BYTES=65536;
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function record(length,fields){const data=Buffer.alloc(length);for(const [offset,value,width=4]of fields)width===2?data.writeUInt16LE(value,offset):data.writeUInt32LE(value,offset);return data;}
async function outputFile(filename,signal,touch,action){
 signal.throwIfAborted();const file=await fs.open(filename,'wx',0o600);let offset=0;
 try{
  const write=async bytes=>{
   let written=0;
   while(written<bytes.length){signal.throwIfAborted();const result=await file.write(bytes,written,bytes.length-written,offset);signal.throwIfAborted();if(!result.bytesWritten)throw Error('L’écriture de l’archive a été interrompue.');written+=result.bytesWritten;offset+=result.bytesWritten;touch();}
  };
  const result=await action(write,()=>offset);signal.throwIfAborted();await file.sync();return result;
 }finally{await file.close();}
}
async function readMember(source,member,mask,signal,touch,consume){
 const buffer=Buffer.alloc(CHUNK_BYTES);let position=0;
 while(position<member.size){
  signal.throwIfAborted();const requested=Math.min(buffer.length,member.size-position),part=await source.read(buffer,0,requested,member.position+position);signal.throwIfAborted();
  if(!part.bytesRead)throw Error('Le conteneur SNG téléchargé est incomplet.');touch();const bytes=buffer.subarray(0,part.bytesRead);
  if(mask)for(let i=0;i<bytes.length;i++){const relative=position+i;bytes[i]^=mask[relative%16]^(relative&255);}
  await consume(bytes,position);position+=bytes.length;
 }
}
async function writeZipFromSng({sourceFile,header,outputFile:filename,signal,touch=()=>{},includeVideo=true,progress=()=>{}}){
 const members=selectSngMembers(header,{includeVideo}),entries=members.map(member=>({...member,nameBytes:Buffer.from(member.name,'utf8')}));
 if(!entries.some(member=>member.name.toLowerCase()==='song.ini')){const data=Buffer.from(encodeSongIni(header.metadataEntries));entries.unshift({name:'song.ini',nameBytes:Buffer.from('song.ini'),size:data.length,data});}
 const planned=22+entries.reduce((sum,entry)=>sum+entry.size+92+2*entry.nameBytes.length,0);
 if(!Number.isSafeInteger(planned)||planned>MAX_BYTES||planned>=0xffffffff||entries.length>65535)throw Error('La chart dépasse la limite ZIP de 4 Go, en-têtes compris.');
 const source=await fs.open(sourceFile,'r');
 try{return await outputFile(filename,signal,touch,async(write,offset)=>{
  const central=[];let completed=0;
  for(const member of entries){
   const start=offset();let crc=0xffffffff,size=0;
   await write(record(30,[[0,0x04034b50],[4,20,2],[6,0x808,2],[12,0x21,2],[26,member.nameBytes.length,2]]));await write(member.nameBytes);
   const consume=async bytes=>{for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);await write(bytes);size+=bytes.length;progress({name:member.name,bytes:size,size:member.size,completed,total:entries.length});};
   if(member.data)await consume(member.data);else await readMember(source,member,header.mask,signal,touch,consume);
   if(size!==member.size)throw Error('Le conteneur SNG téléchargé est incomplet.');crc=(crc^0xffffffff)>>>0;
   await write(record(16,[[0,0x08074b50],[4,crc],[8,size],[12,size]]));
   central.push(record(46,[[0,0x02014b50],[4,20,2],[6,20,2],[8,0x808,2],[14,0x21,2],[16,crc],[20,size],[24,size],[28,member.nameBytes.length,2],[42,start]]),member.nameBytes);completed++;
  }
  const start=offset();for(const part of central)await write(part);
  await write(record(22,[[0,0x06054b50],[8,entries.length,2],[10,entries.length,2],[12,offset()-start],[16,start]]));
  if(offset()!==planned)throw Error('La taille du ZIP ne correspond pas à son contenu.');
  return {files:entries.length,bytes:planned,format:'zip'};
 });}finally{await source.close();}
}
async function writeFilteredSng({sourceFile,header,outputFile:filename,signal,touch=()=>{},includeVideo=true,progress=()=>{}}){
 const members=selectSngMembers(header,{includeVideo}),bytes=buildSngHeader(header,members),source=await fs.open(sourceFile,'r');
 try{return await outputFile(filename,signal,touch,async write=>{
  await write(Buffer.from(bytes));let completed=0;
  for(const member of members){await readMember(source,member,null,signal,touch,async part=>{await write(part);progress({name:member.name,completed,total:members.length});});completed++;}
  return {files:members.length,bytes:bytes.length+members.reduce((sum,member)=>sum+member.size,0),format:'sng'};
 });}finally{await source.close();}
}
async function writeFolderFromSng({sourceFile,header,outputDirectory,signal,touch=()=>{},includeVideo=true,progress=()=>{}}){
 const members=selectSngMembers(header,{includeVideo}),entries=members.slice();
 if(!entries.some(member=>member.name.toLowerCase()==='song.ini')){const data=Buffer.from(encodeSongIni(header.metadataEntries));entries.unshift({name:'song.ini',parts:['song.ini'],size:data.length,data});}
 signal.throwIfAborted();await fs.mkdir(outputDirectory,{mode:0o700});const source=await fs.open(sourceFile,'r');
 try{
  let completed=0;
  for(const member of entries){
   signal.throwIfAborted();const target=path.resolve(outputDirectory,...member.parts);if(!target.startsWith(outputDirectory+path.sep))throw Error('Chemin de fichier ChorusEncore invalide.');await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
   await outputFile(target,signal,touch,async write=>{if(member.data)await write(member.data);else await readMember(source,member,header.mask,signal,touch,async bytes=>{await write(bytes);progress({name:member.name,completed,total:entries.length});});});completed++;
  }
  return {files:entries.length,format:'folder'};
 }finally{await source.close();}
}
module.exports={writeZipFromSng,writeFilteredSng,writeFolderFromSng};
