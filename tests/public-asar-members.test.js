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

test('floating catalogue images, live search and translations are hash-bound to the actual release archive', () => {
  const archiveMembers = new Set(literalArray('public-asar-smoke.cjs', 'PUBLIC_MEMBERS'));
  for (const name of ['catalogue-client.cjs', 'catalogue-enchor-client.cjs', 'catalogue-external.cjs', 'catalogue-service.cjs']) assert.ok(archiveMembers.has('companion/' + name), name);
  for (const name of ['catalogue-card.js', 'catalogue-card-data.js', 'catalogue-widget.html', 'catalogue-widget.js', 'catalogue-widget.css', 'localization.js']) assert.ok(archiveMembers.has('companion/ui/' + name), name);
});

test('capture frame readiness is bound to the actual release archive', () => {
  const archiveMembers = new Set(literalArray('public-asar-smoke.cjs', 'PUBLIC_MEMBERS'));
  assert.ok(archiveMembers.has('companion/ui/game-capture-media.js'));
});
