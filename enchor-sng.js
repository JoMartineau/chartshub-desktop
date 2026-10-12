(function(root,factory){
 'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.ChartshubEnchorSng=factory();
})(typeof window==='undefined'?globalThis:window,function(){
 'use strict';
 // Full-file scanner contract: leave room below ClamAV's signed-size ceiling.
 const MAX_BYTES=4000000000,MAX_FILE_BYTES=2147483644,SECTION_BYTES=1048576,MAX_FILES=1000,MAX_HEADER_BYTES=26+8+SECTION_BYTES+8+SECTION_BYTES+8;
 const utf8=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 const invalid=()=>Error('Le fichier ChorusEncore n’est pas un conteneur SNG valide.');
 function validPart(part){return typeof part==='string'&&part.length>0&&part.length<=180&&encoder.encode(part).length<=255
  &&!/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(part)&&!part.includes('..')&&!/[. ]$/.test(part)
  &&!/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part);}
 /** Return null while a bounded header is incomplete; payload bytes are never
  * retained here. The caller must verify the streamed total before publishing. */
 function validateSngHeader(bytes){
  if(!(bytes instanceof Uint8Array))throw invalid();
  const data=bytes.subarray(0,MAX_HEADER_BYTES),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  function u64(offset,maximum=MAX_BYTES){if(offset<0||offset+8>data.length)throw invalid();const value=view.getBigUint64(offset,true);if(value>BigInt(maximum))throw invalid();return Number(value);}
  if(data.length<6)return null;
  if(![83,78,71,80,75,71].every((value,index)=>data[index]===value))throw invalid();
  if(data.length<26)return null;if(view.getUint32(6,true)!==1)throw invalid();
  function section(position){if(position+8>data.length)return null;const length=u64(position,SECTION_BYTES);if(length<8)throw invalid();const start=position+8,end=start+length;if(end>MAX_HEADER_BYTES)throw invalid();if(end>data.length)return null;return {start,end,length};}
  const metadata=section(26);if(!metadata)return null;const metadataCount=u64(metadata.start,4096);let cursor=metadata.start+8;
  if(metadataCount>Math.floor((metadata.length-8)/8))throw invalid();
  function string(end){if(cursor+4>end)throw invalid();const length=view.getInt32(cursor,true);cursor+=4;if(length<0||length>end-cursor)throw invalid();let value;try{value=utf8.decode(data.subarray(cursor,cursor+length));}catch{throw invalid();}cursor+=length;if(/[\0\r\n;]/.test(value))throw invalid();return value;}
  const keys=new Set();for(let i=0;i<metadataCount;i++){const key=string(metadata.end);string(metadata.end);if(!key||key.includes('=')||keys.has(key.toLowerCase()))throw invalid();keys.add(key.toLowerCase());}
  if(cursor!==metadata.end)throw invalid();
  const index=section(metadata.end);if(!index)return null;const files=u64(index.start,MAX_FILES);cursor=index.start+8;
  if(!files||files>Math.floor((index.length-8)/18))throw invalid();
  const names=new Set(),members=[];let notes=false,audio=false;
  for(let i=0;i<files;i++){
   const length=data[cursor++];if(!length||cursor+length+16>index.end)throw invalid();let name;try{name=utf8.decode(data.subarray(cursor,cursor+length));}catch{throw invalid();}cursor+=length;
   const parts=name.split('/');if(parts.length>6||!parts.every(validPart))throw invalid();
   const key=name.normalize('NFC').toLowerCase();if(names.has(key))throw invalid();names.add(key);
   const size=u64(cursor,MAX_FILE_BYTES),position=u64(cursor+8);cursor+=16;members.push({position,size});
   if(/^(?:notes\.chart|notes\.mid)$/i.test(name)&&size>0)notes=true;
   if(/^(?:song|guitar|bass|rhythm|vocals(?:_[12])?|drums(?:_[1-4])?|keys|crowd)\.(?:ogg|opus|mp3|wav|flac|aiff?|m4a)$/i.test(name)&&size>0)audio=true;
  }
  if(cursor!==index.end)throw invalid();
  for(const name of names){const parts=name.split('/');while(parts.length>1){parts.pop();if(names.has(parts.join('/')))throw invalid();}}
  if(index.end+8>data.length)return null;const headerBytes=index.end+8,totalBytes=headerBytes+u64(index.end);
  if(totalBytes>MAX_BYTES||!notes||!audio)throw invalid();let end=headerBytes;
  for(const member of members.sort((a,b)=>a.position-b.position||a.size-b.size)){if(member.position!==end||member.size>totalBytes-end)throw invalid();end+=member.size;}
  if(end!==totalBytes)throw invalid();return {headerBytes,totalBytes,files};
 }
 return {validateSngHeader,MAX_BYTES,MAX_FILE_BYTES,MAX_HEADER_BYTES};
});
