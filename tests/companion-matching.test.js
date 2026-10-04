const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMetadata, classifyMatch, findMatches, buildInstalledLookup, annotateInstalled } = require('../companion/chart-matching.cjs');

const local = { id: 'local-one', relativePath: 'Band/Song/notes.chart', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', album: 'The Colour and the Shape', year: '1997' };
const remote = { id: 'remote-one', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', verified: null, viewUrl: 'https://example.test/charts/one' };

test('metadata normalization handles case, Unicode diacritics, whitespace and formatting without reading arbitrary fields', () => {
  assert.equal(normalizeMetadata('  <b>BÉYONCÉ</b>\t—  De\u0301jà Vu '), 'beyonce deja vu');
  assert.equal(normalizeMetadata('&lt;i&gt;ÉTÉ&lt;/i&gt;&nbsp;&#x65;&#769; &#233;'), 'ete e e');
  assert.equal(normalizeMetadata("Don’t Stop (Now!)"), 'dont stop now');
  assert.equal(normalizeMetadata('ＡＢＣ １２３ 日本語'), 'abc 123 日本語');
  assert.equal(normalizeMetadata('<span class="label">A &amp; B</span>'), 'a b');
  for (const value of [null, undefined, 42, {}, []]) assert.equal(normalizeMetadata(value), '');
  assert.doesNotThrow(() => normalizeMetadata('&#x110000; &#55296; &#0;'));
});

test('complete exact title/artist/charter is only a suggestion and never inferred verification', () => {
  for (const verified of [true, false, null, undefined]) {
    const candidate = { ...remote, verified };
    assert.equal(classifyMatch(local, candidate).kind, 'suggested');
    const match = findMatches(local, [candidate])[0];
    assert.equal(match.remote.verified, verified); assert.equal(match.ambiguous, false);
    assert.deepEqual(Object.keys(match).sort(), ['ambiguous', 'kind', 'reason', 'remote']);
    assert.match(match.reason, /confirmer/);
  }
});

test('punctuation and diacritic equivalents can match while artist/title boundaries stay exact', () => {
  assert.equal(classifyMatch({ ...local, title: 'Déjà-vu!', artist: 'Café Band', charter: 'Émilie' }, { ...remote, title: 'DEJA VU', artist: '<b>Cafe Band</b>', charter: 'Emilie' }).kind, 'suggested');
  for (const patch of [{ title: 'Everlonger' }, { title: 'Ever' }, { artist: 'Foo Fighters Tribute' }, { artist: 'Foo' }, { artist: 'Foo Fighters feat. Guest' }]) {
    assert.equal(classifyMatch(local, { ...remote, ...patch }).kind, 'none');
  }
});

test('live, feat, remix, remaster and version tokens are retained, including unknown angle-bracket tokens', () => {
  for (const suffix of [' (Live)', ' [Remastered 2011]', ' feat. Guest', ' (Radio Edit)', ' Remix', ' Version 2', ' <live>']) {
    assert.equal(classifyMatch(local, { ...remote, title: remote.title + suffix }).kind, 'none', suffix);
  }
  assert.equal(normalizeMetadata('Song <live>'), 'song live');
  assert.equal(normalizeMetadata('Song (feat. Artist)'), 'song feat artist');
  assert.equal(classifyMatch({ ...local, title: 'Everlong (Live)' }, { ...remote, title: 'EVERLONG - LIVE' }).kind, 'suggested');
});

test('missing title/artist prevents candidates, while charter differences remain explicitly possible', () => {
  for (const field of ['title', 'artist']) for (const value of ['', '   ', null, undefined]) {
    assert.equal(classifyMatch({ ...local, [field]: value }, remote).kind, 'none');
    assert.equal(classifyMatch(local, { ...remote, [field]: value }).kind, 'none');
    assert.deepEqual(findMatches(local, [{ ...remote, [field]: value }]), []);
  }
  for (const value of ['', null, undefined, 'OtherCharter']) {
    assert.equal(classifyMatch(local, { ...remote, charter: value }).kind, 'possible');
    assert.equal(classifyMatch({ ...local, charter: value }, remote).kind, 'possible');
  }
  assert.equal(classifyMatch({ ...local, charter: '' }, { ...remote, charter: '' }).kind, 'possible');
});

test('album/year variants and duplicate catalogue records remain visible and ambiguous', () => {
  const candidates = [
    { ...remote, id: 'release-b', album: 'Greatest Hits', year: '2009' },
    { ...remote, id: 'release-a', album: 'The Colour and the Shape', year: '1997' },
    { ...remote, id: 'release-a', album: 'The Colour and the Shape', year: '1997' }
  ];
  const matches = findMatches(local, candidates);
  assert.equal(matches.length, 3); assert.ok(matches.every(match => match.ambiguous));
  assert.ok(matches.every(match => /Plusieurs charts/.test(match.reason)));
  assert.deepEqual(matches.map(match => match.remote.id), ['release-a', 'release-a', 'release-b']);
  assert.ok(matches.every(match => match.kind === 'suggested'));
});

test('suggested charters sort before possible candidates with stable ties and no input mutation', () => {
  const candidates = [
    Object.freeze({ ...remote, id: 'z', charter: 'Other' }),
    Object.freeze({ ...remote, id: 'b', charter: 'ExampleCharter' }),
    Object.freeze({ ...remote, id: 'a', charter: 'ExampleCharter' }),
    Object.freeze({ ...remote, id: 'unrelated', title: 'Other song' })
  ];
  const input = Object.freeze(candidates), original = JSON.stringify(input);
  const result = findMatches(Object.freeze({ ...local }), input);
  assert.deepEqual(result.map(match => [match.remote.id, match.kind]), [['a', 'suggested'], ['b', 'suggested'], ['z', 'possible']]);
  assert.ok(result.every(match => match.ambiguous)); assert.equal(JSON.stringify(input), original);
  assert.deepEqual(findMatches(local, null), []);
});

test('installed lookup exposes metadata candidates, preserves local duplicates and never confirms installation', () => {
  const locals = [{ ...local, id: 'z' }, { ...local, id: 'a', charter: 'Other', relativePath: 'Alternate/notes.mid' }];
  const lookup = buildInstalledLookup(locals), annotation = annotateInstalled(remote, lookup);
  assert.deepEqual(annotation.localIds, ['a', 'z']); assert.equal(annotation.status, 'candidate');
  assert.match(annotation.reason, /Plusieurs entrées locales/); assert.match(annotation.reason, /confirmer/);
  assert.equal(Object.hasOwn(annotation, 'verified'), false); assert.equal(Object.hasOwn(annotation, 'installed'), false);
  annotation.localIds.pop(); assert.equal(annotateInstalled(remote, lookup).localIds.length, 2);
  assert.equal(annotateInstalled({ ...remote, title: 'Other song' }, lookup).status, 'none');
});

test('lookup normalization respects Unicode metadata and ignores incomplete records or missing IDs', () => {
  const lookup = buildInstalledLookup([
    { ...local, id: 'unicode', title: 'Été', artist: 'Beyoncé' },
    { ...local, id: 'incomplete', artist: '' },
    { ...local, id: '' },
    null
  ]);
  assert.deepEqual(annotateInstalled({ ...remote, title: 'ETE', artist: 'BEYONCE' }, lookup).localIds, ['unicode']);
  assert.equal(annotateInstalled({ ...remote, artist: '' }, lookup).status, 'none');
  assert.equal(annotateInstalled(remote, lookup).status, 'none');
  assert.equal(annotateInstalled(remote, null).status, 'none');
});

test('lookup is isolated from local metadata edits and rebuilding it avoids IDs reused across roots', () => {
  const entry = { ...local }, firstRoot = buildInstalledLookup([entry]);
  entry.title = 'New title'; entry.charter = 'Different';
  assert.equal(annotateInstalled(remote, firstRoot).status, 'candidate');
  const secondRoot = buildInstalledLookup([entry]);
  assert.equal(annotateInstalled(remote, secondRoot).status, 'none');
  assert.deepEqual(annotateInstalled({ ...remote, title: 'New title' }, secondRoot).localIds, [local.id]);
});
