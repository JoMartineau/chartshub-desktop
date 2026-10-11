'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSongRequests, LIMITS, parseCommand } = require('../companion/song-requests.cjs');

const hash = value => createHash('sha256').update(String(value)).digest('hex');
function deferred() {
  let done;
  const promise = new Promise(resolve => { done = resolve; });
  return { promise, done };
}
function fixture(count = 6) {
  let clock = 0, revision = 1, rootKey = hash('Songs');
  let resolveHook = null, searchHook = null, nowPlaying = null;
  const songs = Array.from({ length: count }, (_, i) => ({ id: hash(`song-${i}`), title: `Track ${i}`,
    artist: 'Band', charter: 'Mapper', durationMs: 180_000,
    tracks: [{ instrument: 'guitar', difficulty: 'expert' }, { instrument: 'drums', difficulty: 'hard' }],
    relativePath: `PRIVATE/path${i}/notes.chart`, folderPath: 'C:\\PRIVATE\\Songs', signature: 'PRIVATE_SIGNATURE' }));
  const calls = { search: [], resolve: [] }, changes = [];
  const core = createSongRequests({
    getLibrarySnapshot: () => ({ rootKey, revision, items: songs }),
    searchSongs: async options => {
      calls.search.push(options);
      if (searchHook) await searchHook(options);
      const matches = songs.filter(song => `${song.title} ${song.artist} ${song.charter}`.toLowerCase().includes(options.query.toLowerCase()));
      return { items: matches.slice(0, options.limit), total: matches.length, revision };
    },
    resolveSong: async (id, context) => {
      calls.resolve.push({ id, context });
      if (resolveHook) await resolveHook(id, context);
      const song = songs.find(item => item.id === id);
      if (!song) throw Error('Missing C:\\PRIVATE\\Songs\\notes.chart');
      return song;
    },
    getNowPlaying: async () => nowPlaying,
    onChange: value => changes.push(value), now: () => clock
  });
  let nextEvent = 0;
  const event = (viewer = 'viewer-1', choice = 0, overrides = {}) => ({ platform: 'twitch',
    eventId: `event-${nextEvent++}`, viewerId: viewer, viewerName: `Name ${viewer}`,
    songId: songs[choice]?.id, ...overrides });
  return { core, songs, calls, changes, event,
    advance: value => { clock += value; }, change: () => revision++,
    root: value => { rootKey = hash(value); revision++; },
    setResolve: value => { resolveHook = value; }, setSearch: value => { searchHook = value; },
    setPlaying: value => { nowPlaying = value; } };
}
function enabled(count) { const f = fixture(count); f.core.configure({ enabled: true }); return f; }

test('disabled by default; no library access, no event consumed until explicitly enabled', async () => {
  const f = fixture(), event = f.event();
  assert.equal(f.core.snapshot().enabled, false);
  assert.deepEqual(await f.core.receive(event), { ok: false, code: 'disabled' });
  assert.deepEqual(await f.core.search({ query: 'Band' }), { ok: false, code: 'disabled' });
  assert.equal(f.calls.search.length + f.calls.resolve.length, 0);
  f.core.configure({ enabled: true });
  assert.equal((await f.core.receive(event)).action, 'request');
  f.core.configure({ enabled: false });
  assert.equal(f.core.snapshot().requests.length, 1, 'pausing keeps manual moderation available');
  assert.equal((await f.core.reject(f.core.snapshot().requests[0].id)).ok, true);
});

test('public search is bounded, uses opaque local IDs and drops all paths/private callback fields', async () => {
  const f = enabled(15), result = await f.core.search({ query: 'Band' });
  assert.equal(result.ok, true); assert.equal(result.items.length, 10); assert.equal(result.total, 15);
  assert.deepEqual(f.calls.search[0], { query: 'Band', offset: 0, limit: 10 });
  assert.deepEqual(Object.keys(result.items[0]), ['id', 'title', 'artist', 'charter']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for (const query of ['', 'x'.repeat(201), null]) assert.equal((await f.core.search({ query })).code, 'invalid_query');
  assert.equal((await f.core.search({ query: 'Band', limit: 100 })).code, 'invalid_query');
});

test('chat parser handles explicit commands; ordinary chat and malformed/path IDs cannot request songs', async () => {
  assert.deepEqual(parseCommand('!sr Track 0'), { type: 'request', query: 'Track 0' });
  assert.deepEqual(parseCommand(`!sr id:${hash('song')}`), { type: 'request', songId: hash('song') });
  assert.deepEqual(parseCommand('!QUEUE'), { type: 'queue' });
  assert.deepEqual(parseCommand('!song'), { type: 'song' });
  for (const value of ['hello', '!sr', '!sr id:../notes.chart', '!queue extra', '!song extra', '!delete C:\\Songs']) {
    assert.equal(parseCommand(value), null);
  }
  const f = enabled();
  assert.equal((await f.core.receive(f.event('viewer', 0, { songId: undefined, query: 'Track 0' }))).code, 'invalid_command');
  assert.equal((await f.core.receive(f.event('viewer', 0, { songId: '../notes.chart' }))).code, 'invalid_request');
  assert.equal(f.calls.resolve.length, 0);
});

test('query matching requires one unambiguous local chart and can select an opaque suggestion explicitly', async () => {
  const f = enabled();
  const ambiguous = await f.core.receive(f.event('first', 0, { songId: undefined, query: '!sr Band' }));
  assert.equal(ambiguous.code, 'ambiguous'); assert.equal(ambiguous.matches.length, 6);
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.resolve.length, 0);
  assert.ok(!JSON.stringify(ambiguous).includes('PRIVATE'));
  const first = await f.core.receive(f.event('first', 0, { songId: undefined, query: `!sr id:${ambiguous.matches[0].id}` }));
  assert.equal(first.ok, true); assert.equal(first.request.songId, f.songs[0].id);
  const second = await f.core.receive(f.event('second', 0, { songId: undefined, query: '!sr Track 1' }));
  assert.equal(second.request.title, 'Track 1');
  assert.equal((await f.core.receive(f.event('third', 0, { songId: undefined, query: '!sr Not here' }))).code, 'not_found');
});

test('trusted provenance is retained internally; public pseudos remain text and omit private IDs/events/roots', async () => {
  const f = enabled(), result = await f.core.receive(f.event('PRIVATE_VIEWER', 0, {
    eventId: 'PRIVATE_EVENT', platform: 'youtube', viewerName: '<img src=x onerror=alert(1)>\u202e\u0000'
  }));
  assert.equal(result.ok, true);
  assert.equal(result.request.platform, 'youtube');
  assert.equal(result.request.viewerName, '<img src=x onerror=alert(1)>', 'UI must render the pseudo with textContent');
  const serialized = JSON.stringify({ result, snapshot: f.core.snapshot(), changes: f.changes });
  for (const privateValue of ['PRIVATE_VIEWER', 'PRIVATE_EVENT', 'PRIVATE/path', 'PRIVATE_SIGNATURE', hash('Songs')]) {
    assert.ok(!serialized.includes(privateValue));
  }
  result.request.title = 'Changed'; f.core.snapshot().requests[0].title = 'Changed';
  assert.equal(f.core.snapshot().requests[0].title, 'Track 0');
});

test('requester casts first vote; unique platform+viewer votes deduplicate the same active song', async () => {
  const f = enabled(), firstEvent = f.event('same-id'), first = await f.core.receive(firstEvent);
  assert.equal(first.request.votes, 1);
  assert.equal((await f.core.receive(firstEvent)).code, 'duplicate_event');
  assert.equal((await f.core.receive(f.event('same-id'))).code, 'duplicate_vote');
  const vote = await f.core.receive(f.event('same-id', 0, { platform: 'tiktok' }));
  assert.equal(vote.action, 'vote'); assert.equal(vote.request.votes, 2);
  assert.equal(f.core.snapshot().requests.length, 1);
  await f.core.accept(first.request.id);
  assert.equal((await f.core.receive(f.event('other'))).request.votes, 3, 'accepted requests remain votable');
  await f.core.played(first.request.id);
  f.advance(30_000);
  const again = await f.core.receive(f.event('same-id'));
  assert.equal(again.action, 'request'); assert.notEqual(again.request.id, first.request.id);
});

test('vote ranking preserves request time/insertion ties; !queue shows only five songs and viewer position', async () => {
  const f = enabled(8);
  for (let i = 0; i < 7; i++) assert.equal((await f.core.receive(f.event(`viewer-${i}`, i))).ok, true);
  assert.equal(f.core.snapshot().requests[0].title, 'Track 0');
  await f.core.receive(f.event('voter', 6));
  assert.equal(f.core.snapshot().requests[0].title, 'Track 6');
  await f.core.receive(f.event('voter2', 0));
  assert.equal(f.core.snapshot().requests[0].title, 'Track 0', 'equal votes retain original order');
  const queue = await f.core.receive(f.event('viewer-6', 0, { songId: undefined, query: '!queue' }));
  assert.equal(queue.command, 'queue'); assert.equal(queue.items.length, 5); assert.equal(queue.position, 2);
  const absent = await f.core.receive(f.event('absent', 0, { songId: undefined, query: '!queue' }));
  assert.equal(absent.position, null);
  assert.ok(!JSON.stringify(queue).includes('PRIVATE'));
});

test('!song projects only authoritative playing metadata and never invents a playing session', async () => {
  const f = enabled(), command = () => f.event('viewer', 0, { songId: undefined, query: '!song' });
  for (const state of ['idle', 'menu', 'loading', 'paused', 'results']) {
    f.setPlaying({ state, title: 'Retained old title', folder: 'PRIVATE' });
    assert.equal((await f.core.receive(command())).code, 'not_playing');
  }
  f.advance(60_000);
  f.setPlaying({ state: 'playing', title: 'Real title', artist: 'Real artist', charter: 'Mapper', path: 'PRIVATE' });
  const result = await f.core.receive(command());
  assert.deepEqual(result, { ok: true, command: 'song', song: { title: 'Real title', artist: 'Real artist', charter: 'Mapper' } });
  assert.equal(f.core.snapshot().requests.length, 0);
});

test('cooldown and two active creations per viewer do not prevent voting on another active song', async () => {
  const f = enabled();
  const first = await f.core.receive(f.event('owner', 0));
  assert.equal((await f.core.receive(f.event('owner', 1))).code, 'cooldown');
  await f.core.receive(f.event('other', 1));
  assert.equal((await f.core.receive(f.event('owner', 1))).action, 'vote');
  f.advance(30_000);
  assert.equal((await f.core.receive(f.event('owner', 2))).ok, true);
  f.advance(30_000);
  assert.equal((await f.core.receive(f.event('owner', 3))).code, 'viewer_limit');
  await f.core.reject(first.request.id);
  assert.equal((await f.core.receive(f.event('owner', 3))).ok, true);
});

test('per-viewer and global attempt limits apply before expensive lookups, including concurrent arrivals', async () => {
  const f = enabled(), gate = deferred(), started = deferred();
  f.setResolve(async () => { started.done(); await gate.promise; });
  const first = f.core.receive(f.event('viewer', 0)); await started.promise;
  const attempts = Array.from({ length: 4 }, () => f.core.receive(f.event('viewer', 1)));
  assert.equal((await f.core.receive(f.event('viewer', 2))).code, 'rate_limited');
  gate.done(); await first; await Promise.all(attempts);
  assert.equal(f.calls.resolve.length, 1, 'serialized cooldown prevents the other creations');
  const global = enabled(70);
  const results = await Promise.all(Array.from({ length: 61 }, (_, i) => global.core.receive(global.event(`unique-${i}`, 0))));
  assert.equal(results[60].code, 'rate_limited');
  assert.equal(global.calls.resolve.length, 60);
  global.advance(60_000);
  assert.equal((await global.core.receive(global.event('new', 1))).ok, true);
});

test('active queue is bounded, votes still work when full and terminal history is independently bounded', async () => {
  const f = enabled(55);
  for (let i = 0; i < LIMITS.active; i++) assert.equal((await f.core.receive(f.event(`viewer-${i}`, i))).ok, true);
  assert.equal((await f.core.receive(f.event('overflow', 50))).code, 'queue_full');
  assert.equal((await f.core.receive(f.event('voter', 0))).action, 'vote');
  const old = f.core.snapshot().requests.find(item => item.songId === f.songs[0].id);
  await f.core.reject(old.id);
  assert.equal((await f.core.receive(f.event('overflow2', 50))).ok, true);
  for (const item of f.core.snapshot().requests.filter(item => item.status === 'pending')) await f.core.reject(item.id);
  for (let i = 0; i < LIMITS.history; i++) {
    f.advance(60_000);
    const result = await f.core.receive(f.event('history', 0));
    assert.equal(result.ok, true); await f.core.reject(result.request.id);
  }
  assert.equal(f.core.snapshot().requests.length, LIMITS.history);
  assert.ok(!f.core.snapshot().requests.some(item => item.id === old.id));
});

test('owner transitions are explicit, terminal requests cannot be revived, no automatic playback/download/delete', async () => {
  const f = enabled(), request = (await f.core.receive(f.event())).request;
  assert.equal((await f.core.played(request.id)).code, 'invalid_transition');
  assert.equal((await f.core.accept(request.id)).request.status, 'accepted');
  assert.equal((await f.core.accept(request.id)).code, 'invalid_transition');
  assert.equal((await f.core.played(request.id)).request.status, 'played');
  assert.equal((await f.core.reject(request.id)).code, 'invalid_transition');
  assert.equal((await f.core.accept('../Songs')).code, 'invalid_request');
  assert.equal((await f.core.reject('11111111-1111-4111-8111-111111111111')).code, 'not_found');
  assert.equal(f.calls.resolve.length, 2, 'only admission and manual acceptance resolve installed notes');
  assert.equal(f.songs.length, 6);
});

test('changed scan/root, missing files and unsafe resolver targets cannot enter or be accepted', async () => {
  const f = enabled(), request = (await f.core.receive(f.event())).request;
  f.root('Another Songs');
  assert.equal((await f.core.accept(request.id)).code, 'song_unavailable');
  assert.equal(f.core.snapshot().requests[0].status, 'pending');
  const gate = deferred(), started = deferred();
  f.setResolve(async () => { started.done(); await gate.promise; });
  const pending = f.core.receive(f.event('other', 1)); await started.promise;
  f.change(); gate.done();
  assert.equal((await pending).code, 'library_changed');
  assert.equal(f.core.snapshot().requests.length, 1);
  for (const [index, reason] of ['missing notes', 'outside Songs C:\\PRIVATE', 'symlink or junction'].entries()) {
    f.setResolve(async () => { throw Error(reason); });
    const result = await f.core.receive(f.event(`failed-${index}`, 1));
    assert.deepEqual(result, { ok: false, code: 'library_unavailable' });
  }
  assert.equal(f.core.snapshot().requests.length, 1);
});

test('pausing/re-enabling during admission fences stale callbacks; mutating source cannot change admitted identity/song', async () => {
  const f = enabled(), gate = deferred(), started = deferred();
  f.setResolve(async () => { started.done(); await gate.promise; });
  const input = f.event(), pending = f.core.receive(input); await started.promise;
  input.viewerName = 'Injected'; input.songId = f.songs[1].id; input.viewerId = 'another';
  f.core.configure({ enabled: false }); f.core.configure({ enabled: true }); gate.done();
  assert.equal((await pending).code, 'disabled'); assert.equal(f.core.snapshot().requests.length, 0);
  f.setResolve(null);
  const next = f.event('original'), nextPending = f.core.receive(next);
  next.viewerName = 'Injected'; next.songId = f.songs[1].id;
  const result = await nextPending;
  assert.equal(result.request.title, 'Track 0'); assert.equal(result.request.viewerName, 'Name original');
});

test('session rules require actual duration and the same instrument/difficulty track, not unrelated combinations', async () => {
  const f = enabled();
  f.core.configure({ rules: { maxDurationMinutes: 3, instrument: 'guitar', difficulty: 'expert' } });
  assert.equal((await f.core.receive(f.event('allowed', 0))).ok, true);
  f.songs[1].durationMs = 180_001;
  assert.equal((await f.core.receive(f.event('long', 1))).code, 'duration_limit');
  f.songs[2].durationMs = undefined;
  assert.equal((await f.core.receive(f.event('duration-unknown', 2))).code, 'metadata_unknown');
  f.songs[3].tracks = [{ instrument: 'guitar', difficulty: 'easy' }, { instrument: 'drums', difficulty: 'expert' }];
  assert.equal((await f.core.receive(f.event('wrong-combination', 3))).code, 'difficulty_unavailable');
  f.songs[4].tracks = undefined;
  assert.equal((await f.core.receive(f.event('tracks-unknown', 4))).code, 'metadata_unknown');
  f.songs[5].tracks = [{ instrument: 'drums', difficulty: 'expert' }];
  assert.equal((await f.core.receive(f.event('instrument-missing', 5))).code, 'instrument_unavailable');
});

test('unknown partial tracks are refused honestly; rules changed mid-admission/acceptance are enforced', async () => {
  const f = enabled(), first = await f.core.receive(f.event());
  f.core.configure({ rules: { difficulty: 'expert' } });
  f.songs[1].tracks = [{ instrument: 'guitar', difficulty: null }];
  assert.equal((await f.core.receive(f.event('unknown', 1))).code, 'metadata_unknown');
  const gate = deferred(), started = deferred();
  f.setResolve(async () => { started.done(); await gate.promise; });
  const pending = f.core.receive(f.event('changed', 2)); await started.promise;
  f.core.configure({ rules: { maxDurationMinutes: 2 } }); gate.done();
  assert.equal((await pending).code, 'duration_limit');
  f.setResolve(null);
  assert.equal((await f.core.accept(first.request.id)).code, 'duration_limit');
  assert.equal(f.core.snapshot().requests[0].status, 'pending');
  const state = f.core.snapshot(); state.rules.maxDurationMinutes = null;
  assert.equal(f.core.snapshot().rules.maxDurationMinutes, 2);
});

test('configuration validates bounded rules without implicitly enabling viewer reception', () => {
  const f = fixture(); f.core.configure({ rules: { instrument: 'drums' } });
  assert.equal(f.core.snapshot().enabled, false);
  for (const rules of [{ maxDurationMinutes: 0 }, { maxDurationMinutes: 61 }, { maxDurationMinutes: 2.5 },
    { instrument: '../Songs' }, { difficulty: 'impossible' }, { delete: true }]) {
    assert.throws(() => f.core.configure({ rules }), TypeError);
  }
  assert.throws(() => f.core.configure({ enabled: 'yes' }), TypeError);
  assert.throws(() => f.core.configure({ rules: null }), TypeError);
  assert.throws(() => f.core.configure({ rules: [] }), TypeError);
  assert.throws(() => f.core.configure({}), TypeError);
  assert.throws(() => createSongRequests(), TypeError);
});

test('!vote only votes for active requests; selecting an installed but unqueued chart cannot create a request', async () => {
  const f = enabled(), command = (viewer, query) => f.event(viewer, 0, { songId: undefined, query });
  assert.deepEqual(parseCommand('!vote Track 0'), { type: 'vote', query: 'Track 0' });
  assert.equal((await f.core.receive(command('voter', '!vote Track 0'))).code, 'not_queued');
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.resolve.length, 0);
  const initial = await f.core.receive(f.event('owner'));
  const vote = await f.core.receive(command('voter', `!vote id:${f.songs[0].id}`));
  assert.equal(vote.action, 'vote'); assert.equal(vote.request.votes, 2);
  await f.core.reject(initial.request.id);
  assert.equal((await f.core.receive(command('later', '!vote Track 0'))).code, 'not_queued');
});

test('native exported metadata has an explicit exported flag and cannot be presented as actual playback', async () => {
  const f = enabled();
  f.setPlaying({ state: 'exported', title: 'Last exported track', artist: 'Band', charter: 'Mapper',
    songId: 'PRIVATE_ID', path: 'PRIVATE_PATH' });
  const result = await f.core.receive(f.event('viewer', 0, { songId: undefined, query: '!song' }));
  assert.deepEqual(result, { ok: true, command: 'song',
    song: { title: 'Last exported track', artist: 'Band', charter: 'Mapper', exported: true } });
});

test('manual up/down ordering survives new votes/acceptance and appends new songs until explicit reset', async () => {
  const f = enabled(), ids = [];
  for (let i = 0; i < 3; i++) ids.push((await f.core.receive(f.event(`viewer-${i}`, i))).request.id);
  const before = f.core.snapshot().revision;
  assert.equal((await f.core.move(ids[0], { direction: 'up' })).moved, false);
  assert.equal(f.core.snapshot().order, 'votes'); assert.equal(f.core.snapshot().revision, before);
  assert.equal((await f.core.move(ids[2], { direction: 'up' })).moved, true);
  assert.equal(f.core.snapshot().order, 'manual');
  assert.deepEqual(f.core.snapshot().requests.map(item => item.id), [ids[0], ids[2], ids[1]]);
  await f.core.receive(f.event('extra-voter', 1));
  await f.core.accept(ids[2]);
  assert.deepEqual(f.core.snapshot().requests.map(item => item.id), [ids[0], ids[2], ids[1]], 'votes/status cannot undo explicit order');
  const added = (await f.core.receive(f.event('new-viewer', 3))).request.id;
  assert.deepEqual(f.core.snapshot().requests.map(item => item.id), [ids[0], ids[2], ids[1], added]);
  await f.core.move(ids[0], { direction: 'down' });
  await f.core.reject(ids[2]);
  assert.deepEqual(f.core.snapshot().requests.filter(item => item.status !== 'rejected').map(item => item.id), [ids[0], ids[1], added]);
  await f.core.resetOrder();
  assert.equal(f.core.snapshot().order, 'votes'); assert.equal(f.core.snapshot().requests[0].id, ids[1]);
  assert.equal((await f.core.move(ids[2], { direction: 'up' })).code, 'invalid_transition');
  assert.equal((await f.core.move('../notes.chart', { direction: 'up' })).code, 'invalid_request');
  assert.equal((await f.core.move(ids[0], { direction: 'sideways' })).code, 'invalid_request');
});

test('catalogue/foreign IDs, forged resolver identities and malformed event provenance are refused', async () => {
  const f = enabled();
  assert.equal((await f.core.receive(f.event('viewer', 0, { songId: hash('not-installed') }))).code, 'song_unavailable');
  assert.equal(f.calls.resolve.length, 0);
  for (const override of [{ platform: 'discord' }, { viewerId: '' }, { viewerName: '' }, { eventId: 'bad event' },
    { viewerName: 'x'.repeat(257) }, { songId: ['../notes.chart'] }, { query: 'x'.repeat(201) }]) {
    assert.equal((await f.core.receive(f.event('valid', 0, override))).code, 'invalid_request');
  }
  const core = createSongRequests({
    getLibrarySnapshot: () => ({ rootKey: hash('Songs'), revision: 1, items: f.songs }),
    searchSongs: async () => ({ items: [{ id: hash('foreign'), title: 'PRIVATE' }], total: 1, revision: 1 }),
    resolveSong: async () => ({ id: hash('foreign') })
  });
  core.configure({ enabled: true });
  assert.equal((await core.search({ query: 'PRIVATE' })).items.length, 0);
  assert.equal((await core.receive(f.event())).code, 'song_unavailable');
  assert.equal(core.snapshot().requests.length, 0);
});

test('scope and rules are checked again at the final nested-await commit boundary', async () => {
  for (const change of ['scope', 'rules']) {
    let revision = 1, reads = 0;
    const song = { id: hash('boundary-song'), title: 'Track', artist: 'Band', durationMs: 180_000,
      tracks: [{ instrument: 'guitar', difficulty: 'expert' }] };
    const core = createSongRequests({
      getLibrarySnapshot: () => {
        const current = { rootKey: hash('Songs'), revision, items: [song] };
        if (++reads === 2) queueMicrotask(() => {
          if (change === 'scope') revision++;
          else core.configure({ rules: { maxDurationMinutes: 2 } });
        });
        return current;
      },
      searchSongs: async () => ({ items: [song], total: 1, revision }), resolveSong: async () => song
    });
    core.configure({ enabled: true });
    const result = await core.receive({ platform: 'twitch', eventId: 'event', viewerId: 'viewer', viewerName: 'Viewer', songId: song.id });
    assert.equal(result.code, change === 'scope' ? 'library_changed' : 'duration_limit');
    assert.equal(core.snapshot().requests.length, 0);
  }
});

test('vote identity storage is bounded without dropping earlier unique-vote protection', async () => {
  const f = enabled(), first = await f.core.receive(f.event('owner'));
  for (let i = 1; i < LIMITS.votesPerSong; i++) {
    f.advance(60_000);
    assert.equal((await f.core.receive(f.event(`voter-${i}`))).action, 'vote');
  }
  f.advance(60_000);
  assert.equal((await f.core.receive(f.event('overflow'))).code, 'vote_limit');
  assert.equal((await f.core.receive(f.event('owner'))).code, 'duplicate_vote', 'expired rate records must not allow repeated votes');
  assert.equal(f.core.snapshot().requests[0].votes, LIMITS.votesPerSong);
  await f.core.reject(first.request.id);
  assert.equal(f.core.snapshot().requests[0].votes, LIMITS.votesPerSong, 'history keeps count while private voter set is released');
});

test('unknown instruments cannot prove a playable difficulty and empty known track lists fail active rules', async () => {
  const f = enabled(); f.core.configure({ rules: { difficulty: 'expert' } });
  f.songs[0].tracks = [{ instrument: 'unknown', difficulty: 'expert' }];
  assert.equal((await f.core.receive(f.event('unknown'))).code, 'metadata_unknown');
  f.songs[1].tracks = [];
  assert.equal((await f.core.receive(f.event('empty', 1))).code, 'difficulty_unavailable');
});
