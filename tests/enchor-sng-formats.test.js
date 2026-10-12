'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const codec=require('../enchor-sng');
// Independent wire-format fixture, including cipher positions past 255 bytes.
function fixture(metadata=[['name','Été; Part = II'],['artist','Band; Ensemble']]){
 const mask=Buffer.from('f1e2d3c4b5a69780'),files=[['notes.chart',Buffer.from('[Song]\n{}')],['song.ogg',Buffer.from(Array.from({length:547},(_,i)=>i&255))],['video.webm',Buffer.from('full video')],['background.mp4',Buffer.from('background video')],['extras/video.webm',Buffer.from('keep nested video')],['album.jpg',Buffer.from('cover')]];
 const pairs=metadata.map(pair=>pair.map(value=>Buffer.from(value))),metaSize=8+pairs.reduce((n,[k,v])=>n+8+k.length+v.length,0),indexSize=8+files.reduce((n,[name])=>n+17+Buffer.byteLength(name),0),headerSize=26+8+metaSize+8+indexSize+8,header=Buffer.alloc(headerSize);let cursor=0;
 const bytes=value=>{value.copy(header,cursor);cursor+=value.length;},u32=value=>{header.writeUInt32LE(value,cursor);cursor+=4;},u64=value=>{header.writeBigUInt64LE(BigInt(value),cursor);cursor+=8;};
 bytes(Buffer.from('SNGPKG'));u32(1);bytes(mask);u64(metaSize);u64(pairs.length);for(const pair of pairs)for(const value of pair){u32(value.length);bytes(value);}
 u64(indexSize);u64(files.length);let offset=headerSize;for(const [name,data] of files){const encoded=Buffer.from(name);header[cursor++]=encoded.length;bytes(encoded);u64(data.length);u64(offset);offset+=data.length;}u64(offset-headerSize);
 return {files,data:Buffer.concat([header,...files.map(([,data])=>Buffer.from(data.map((byte,i)=>byte^mask[i%16]^(i&255))))])};
}
function decoded(data,header){return header.members.map(member=>[member.name,Buffer.from(data.subarray(member.position,member.position+member.size).map((byte,i)=>byte^header.mask[i%16]^(i&255)))]);}
test('expanded header preserves metadata, mask, positions and old validator contract',()=>{
 const f=fixture(),h=codec.parseSngHeader(f.data);assert.deepEqual(codec.validateSngHeader(f.data),{headerBytes:h.headerBytes,totalBytes:f.data.length,files:6});assert.deepEqual(decoded(f.data,h),f.files);assert.deepEqual(h.metadataEntries,[{key:'name',value:'Été; Part = II'},{key:'artist',value:'Band; Ensemble'}]);
 for(let i=0;i<h.headerBytes;i++)assert.equal(codec.parseSngHeader(f.data.subarray(0,i)),null);const mask=Buffer.from(h.mask);f.data.fill(0,10,26);assert.deepEqual(Buffer.from(h.mask),mask,'parsed mask owns its bytes');
});
test('repacked SNG keeps every encrypted member and exact metadata with video enabled',()=>{
 const f=fixture(),h=codec.parseSngHeader(f.data),members=codec.selectSngMembers(h),rebuilt=Buffer.concat([codec.buildSngHeader(h,members),...members.map(m=>f.data.subarray(m.position,m.position+m.size))]);assert.deepEqual(rebuilt,f.data);assert.deepEqual(decoded(rebuilt,codec.parseSngHeader(rebuilt)),f.files);
});
test('video opt-out removes only recognized root videos and relocates untouched encrypted members',()=>{
 const f=fixture(),h=codec.parseSngHeader(f.data),members=codec.selectSngMembers(h,{includeVideo:false}),rebuilt=Buffer.concat([codec.buildSngHeader(h,members),...members.map(m=>f.data.subarray(m.position,m.position+m.size))]),parsed=codec.parseSngHeader(rebuilt);assert.equal(parsed.totalBytes,rebuilt.length);assert.deepEqual(decoded(rebuilt,parsed),f.files.filter(([name])=>!['video.webm','background.mp4'].includes(name)));assert.ok(members.some(m=>m.name==='extras/video.webm'));
});
test('song.ini synthesis preserves UTF-8, equals signs and semicolons',()=>{
 const h=codec.parseSngHeader(fixture().data);assert.equal(Buffer.from(codec.encodeSongIni(h.metadataEntries)).toString('utf8'),'[Song]\nname = Été; Part = II\nartist = Band; Ensemble\n');for(const key of [' name','name ','#name','[name]','na\tme'])assert.throws(()=>codec.encodeSongIni([{key,value:'valid'}]),/Choisissez SNG/);
});
test('repacking cannot invent paths, alter sizes, duplicate members or lose playable files',()=>{
 const h=codec.parseSngHeader(fixture().data),all=h.members;for(const members of [[],[all[0]],[all[1]],all.concat(all[0]),[{...all[0],name:'../escape'},all[1]],[{...all[0],size:all[0].size+1},all[1]],[{...all[0],position:0},all[1]]])assert.throws(()=>codec.buildSngHeader(h,members),/SNG valide/);
 assert.throws(()=>codec.selectSngMembers(h,{includeVideo:'false'}),/SNG valide/);assert.throws(()=>codec.encodeSongIni([{key:'NAME',value:'a'},{key:'name',value:'b'}]),/SNG valide/);assert.throws(()=>codec.encodeSongIni([{key:'name',value:'bad\nline'}]),/SNG valide/);
});
