'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function literalArray(file, name) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const match = source.match(new RegExp('const ' + name + ' = (?:Object\\.freeze\\()?(\\[[\\s\\S]*?\\])\\)?;'));
  assert.ok(match, 'The actual fixture must declare ' + name);
  return Array.from(vm.runInNewContext(match[1], {}, { timeout: 1000 }));
}

test('every optional native fixture source digest is bound to a required member in the actual release ASAR', () => {
  const archiveMembers = new Set(literalArray('public-asar-smoke.cjs', 'PUBLIC_MEMBERS'));
  const nativeSources = literalArray('game-widget-integrations-electron.cjs', 'sourceNames');
  assert.ok(nativeSources.includes('companion/ui/song-visuals-controls.js'), 'The renderer status exercised by the optional fixture must remain hash-bound');
  assert.equal(new Set(nativeSources).size, nativeSources.length, 'Fixture source identities must be distinct');
  assert.deepEqual(nativeSources.filter(name => !archiveMembers.has(name)), [], 'Every before/after digest needs its actual archive-member digest');
});
