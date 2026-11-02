'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ownedIdentity}=require('../enchor-download');

test('ownership distinguishes 64-bit file IDs even with identical preserved creation times',()=>{
 const left={dev:782947067n,ino:21673573208088972n,birthtimeNs:1793637544098570300n};
 const right={...left,ino:left.ino+1n};
 assert.equal(Number(left.ino),Number(right.ino),'fixture must reproduce a real Number collision');
 assert.notEqual(ownedIdentity(left),ownedIdentity(right));
 assert.equal(ownedIdentity({...left}),ownedIdentity(left));
});

test('rounded or incomplete stat metadata cannot authorize ownership',()=>{
 const value={dev:1n,ino:21673573208088973n,birthtimeNs:1793637544098570300n};
 for(const field of ['dev','ino','birthtimeNs']){
  assert.throws(()=>ownedIdentity({...value,[field]:Number(value[field])}),error=>error.code==='DOWNLOAD_PATH');
  const missing={...value};delete missing[field];assert.throws(()=>ownedIdentity(missing),error=>error.code==='DOWNLOAD_PATH');
 }
});
