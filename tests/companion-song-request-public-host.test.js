'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../companion/host.cjs'), 'utf8');
const start = source.indexOf('  songRequestShareBroker = createSongRequestPublicBroker('), end = source.indexOf('  function songRequestShareContext()', start);
assert.ok(start > 0 && end > start, 'The actual host broker initialization remains identifiable.');
function fixture() {
  const state = { enabled: true, rules: { maxDurationMinutes: null, instrument: 'all', difficulty: 'all' },
    library: { status: 'ready', count: 1 }, index: { rootKey: 'a'.repeat(64), revision: 1 } };
  let options; const received = [];
  const context = { catalogueAccess: true, hostActive: true, disposing: false, stopTask: null, lifecycleRevision: 1,
    songRequestShare: { url: 'https://fixture.invalid/public', revision: '11111111-1111-4111-8111-111111111111', busy: false },
    songRequestShareManualBusy: null, songRequestShareBroker: null, sharingClient: {}, publishPanel() {},
    createSongRequestPublicBroker: value => { options = value; return {}; },
    library: { status: () => state.library, matchingSnapshot: () => state.index },
    songRequests: { snapshot: () => ({ enabled: state.enabled, rules: state.rules }), receive: (...args) => received.push(args) } };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'actual host public request initialization' });
  return { state, context, options, received };
}
test('actual host integration requires owner access, published sharing, an active panel, ready Songs and explicit reception', () => {
  const f = fixture(); assert.equal(f.options.context().active, true);
  for (const [name, blocked] of [['catalogueAccess', false], ['hostActive', false], ['disposing', true], ['stopTask', {}], ['songRequestShareManualBusy', {}]]) {
    const previous = f.context[name]; f.context[name] = blocked; assert.equal(f.options.context().active, false, name); f.context[name] = previous;
  }
  f.state.enabled = false; assert.equal(f.options.context().active, false); f.state.enabled = true;
  f.state.library.status = 'scanning'; assert.equal(f.options.context().active, false); f.state.library.status = 'ready';
  f.state.library.count = 0; assert.equal(f.options.context().active, false); f.state.library.count = 1;
  f.context.songRequestShare.busy = true; assert.equal(f.options.context().active, false); f.context.songRequestShare.busy = false;
  f.context.songRequestShare.url = null; assert.equal(f.options.context().active, false);
});
test('actual host scope changes fence old root, scan, rules, public revision and lifecycle; resolver guards are forwarded intact', () => {
  const f = fixture();
  for (const change of [() => f.state.index.rootKey = 'b'.repeat(64), () => f.state.index.revision++,
    () => f.state.rules.maxDurationMinutes = 2, () => f.context.songRequestShare.revision = '22222222-2222-4222-8222-222222222222',
    () => f.context.lifecycleRevision++]) {
    const before = f.options.context().key; change(); assert.notEqual(f.options.context().key, before);
  }
  const input = { platform: 'website', songId: 'c'.repeat(64) }, options = { isCurrent: () => false };
  f.options.receive(input, options); assert.equal(f.received[0][0], input); assert.equal(f.received[0][1], options);
});
