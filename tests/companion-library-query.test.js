const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('query pagination reuses normalized metadata and each sort order without retaining returned pages', () => {
  let reads = 0, comparisons = 0;
  // Observe costly platform operations without timing assumptions or exposing cache internals.
  const local = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../companion/library-query.cjs'), 'utf8'), {
    module: local,
    Intl: { Collator: function (...args) {
      const collator = new Intl.Collator(...args);
      this.compare = (left, right) => { comparisons++; return collator.compare(left, right); };
    } }
  });
  const textFields = ['title', 'artist', 'charter', 'album', 'year'];
  const publicFields = ['id', 'relativePath', ...textFields, 'format', 'audio'];
  const items = Array.from({ length: 1200 }, (_, i) => {
    const source = { id: String(i), relativePath: `Folder ${i}/notes.chart`, title: `Track ${1200 - i}`,
      artist: `Band ${i % 5}`, charter: `Mapper ${i % 3}`, album: 'Collection', year: '2026', format: 'chart', audio: 'missing' };
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value]));
  });
  const observed = items.map(item => Object.defineProperties({}, Object.fromEntries(Object.entries(item).map(([key, value]) => [key, {
    enumerable: true, get() { reads++; return value; }
  }]))));
  const document = { items: observed, settings: { rootPath: '/library' }, revision: 1 };
  const query = local.exports.createLibraryQuery({ textFields, publicFields });
  for (const sort of ['title', 'artist', 'charter']) {
    const first = query(document, { query: 'band', sort, audio: 'missing', offset: 0, limit: 10 });
    assert.equal(first.total, items.length); assert.ok(comparisons > 0);
    reads = 0; comparisons = 0;
    const next = query(document, { query: ' BAND ', sort, audio: 'missing', offset: 10, limit: 10 });
    assert.equal(next.total, items.length); assert.equal(next.items.length, 10);
    assert.equal(comparisons, 0, 'another page must not sort the library again');
    assert.ok(reads <= publicFields.length * 10, 'warm pagination must read only returned metadata');
    assert.notEqual(next.items[0].id, first.items[0].id);
    reads = 0; comparisons = 0;
    query(document, { query: 'band 2', sort, limit: 10 });
    assert.equal(comparisons, 0, 'new search text reuses its established sort order');
    assert.ok(reads <= publicFields.length * 10, 'new searches reuse normalized metadata');
  }
  // More distinct queries than the small result cache can retain still reuse metadata/order.
  for (let i = 0; i < 30; i++) query(document, { query: `track ${i}`, sort: 'title' });
  reads = 0; comparisons = 0;
  const again = query(document, { query: 'band', sort: 'title', limit: 10 });
  assert.equal(again.total, items.length); assert.equal(comparisons, 0); assert.ok(reads <= publicFields.length * 10);
  again.items[0].title = 'Mutated'; again.items.length = 0;
  assert.equal(query(document, { query: 'band', sort: 'title', limit: 10 }).items[0].title, 'Track 1');
});

test('duplicate candidates must have distinct paths even if the same record is supplied twice', () => {
  const { createLibraryQuery } = require('../companion/library-query.cjs');
  const textFields = ['title', 'artist', 'charter', 'album', 'year'];
  const query = createLibraryQuery({ textFields, publicFields: [...textFields, 'relativePath', 'audio'] });
  const item = { title: 'Song', artist: 'Band', charter: 'Mapper', album: '', year: '', relativePath: 'A/notes.chart', audio: 'present' };
  const document = { items: [item, { ...item }], settings: { rootPath: '/library' }, revision: 1 };
  assert.equal(query(document, { duplicates: 'possible' }).total, 0);
  document.items = [item, { ...item, relativePath: 'B/notes.chart' }];
  assert.equal(query(document, { duplicates: 'possible' }).total, 2, 'item identity changes invalidate cached groups even at the same revision');
});
