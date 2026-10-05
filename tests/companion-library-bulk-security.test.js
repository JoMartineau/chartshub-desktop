'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validCommand}=require('../companion/security.cjs');

test('bulk duplicate verification IPC accepts only an empty request',()=>{
  assert.equal(validCommand('library.verifyAllDuplicates',undefined,[]),true);
  assert.equal(validCommand('library.verifyAllDuplicates',null,[]),true);
  assert.equal(validCommand('library.verifyAllDuplicates',{},[]),true);
  assert.equal(validCommand('library.verifyAllDuplicates',{revision:1},[]),false);
  assert.equal(validCommand('library.verifyAllDuplicates','all',[]),false);
});
