const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('../companion/dist/core/events/EventBus.js'),
  import('../companion/dist/core/state/createStore.js'),
  import('../companion/dist/core/services/normalizeSong.js'),
  import('../companion/dist/core/services/ServiceContainer.js'),
  import('../companion/dist/integrations/clonehero/MockCloneHeroIntegration.js'),
]).then(values => Object.assign({}, ...values));

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function logger() {
  const entries = [];
  return { entries, info: (...args) => entries.push(['info', ...args]), warn: (...args) => entries.push(['warn', ...args]), error: (...args) => entries.push(['error', ...args]) };
}
function widget() {
  return { id: 'title-1', type: 'song-title', enabled: true, position: { x: 20, y: 40 }, size: { width: 300, height: 40 }, visibility: { game: true, stream: false }, gameplayVisibility: ['playing', 'paused'], style: {}, config: {} };
}

class FakeIntegration {
  listeners = new Set();
  connections = 0;
  disconnections = 0;
  songReads = 0;
  state = { state: 'menu', isChartActive: false };
  song = { title: '  Everlong ', artist: ' Foo  Fighters ' };
  connect = async () => { ++this.connections; };
  disconnect = async () => { ++this.disconnections; };
  getGameplayState = async () => this.state;
  getCurrentSong = async () => { ++this.songReads; return this.song; };
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  transition(state) {
    this.state = { state, isChartActive: state === 'playing' || state === 'paused' };
    this.emit({ type: 'gameplay', gameplay: this.state });
  }
}

test('Companion EventBus delivers typed events, isolates failures, and unsubscribes', async () => {
  const { EventBus } = await modules;
  const logs = logger();
  const bus = new EventBus(logs);
  const seen = [];
  const stopBad = bus.on('nowPlaying.changed', () => { throw new Error('broken listener'); });
  const stopGood = bus.on('nowPlaying.changed', song => seen.push(song.title));
  bus.emit('nowPlaying.changed', { title: 'Everlong' });
  assert.deepEqual(seen, ['Everlong']);
  assert.ok(logs.entries.some(entry => entry[1] === 'Event listener failed'));
  stopBad();
  stopGood();
  stopGood();
  bus.emit('nowPlaying.changed', { title: 'Removed' });
  assert.deepEqual(seen, ['Everlong']);
  bus.on('nowPlaying.changed', song => seen.push(song.title));
  stopGood();
  bus.emit('nowPlaying.changed', { title: 'New subscription' });
  assert.deepEqual(seen, ['Everlong', 'New subscription'], 'old unsubscribe cannot remove a new listener group');
});

test('Companion store has all initial slices and isolates subscriber failures', async () => {
  const { createStore } = await modules;
  const logs = logger();
  const store = createStore(undefined, logs);
  assert.deepEqual(Object.keys(store.getState()).sort(), ['gameplay', 'nowPlaying', 'serviceHealth', 'widgets']);
  assert.deepEqual(store.getState().gameplay, { state: 'idle', isChartActive: false });
  assert.equal(store.getState().nowPlaying, null);
  assert.deepEqual(store.getState().widgets.instances, []);
  let notifications = 0;
  store.subscribe(() => { throw new Error('bad subscriber'); });
  const unsubscribe = store.subscribe(() => { ++notifications; });
  store.setState(state => ({ ...state, widgets: { instances: [widget()] } }));
  assert.equal(notifications, 1);
  assert.equal(store.getState().widgets.instances[0].id, 'title-1');
  store.setState(state => state);
  assert.equal(notifications, 1);
  unsubscribe();
  store.setState(state => ({ ...state, widgets: { instances: [] } }));
  assert.equal(notifications, 1);
  assert.ok(logs.entries.some(entry => entry[1] === 'State subscriber failed'));
});

test('Companion normalization preserves useful optional fields and rejects missing sentinels', async () => {
  const { normalizeSong } = await modules;
  assert.deepEqual(normalizeSong({
    songId: ' chart-1 ', title: ' Everlong\n ', artist: ' Foo  Fighters ', album: ' The Colour and the Shape ',
    charter: ' ExampleCharter ', instrument: ' Guitar ', difficulty: ' Expert ', verifiedCharter: ' true ',
    artworkUrl: ' https://example.test/art.png ', bpm: ' 158.5 ', noteCount: ' 1200 ', score: '12000',
    accuracy: '98.72', combo: '426', maxCombo: 500, misses: 0, elapsedMs: '1000', durationMs: '250000',
  }), {
    songId: 'chart-1', title: 'Everlong', artist: 'Foo Fighters', album: 'The Colour and the Shape',
    charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert', artworkUrl: 'https://example.test/art.png',
    noteCount: 1200, score: 12000, combo: 426, maxCombo: 500, misses: 0,
    bpm: 158.5, elapsedMs: 1000, durationMs: 250000, accuracy: 98.72, verifiedCharter: true,
  });
  assert.equal(normalizeSong(null), null);
  assert.equal(normalizeSong({ title: ' N/A ', artist: 'null', charter: 'UNDEFINED', instrument: ' ', difficulty: 'unknown', bpm: NaN, accuracy: 101, noteCount: -1, score: Infinity, durationMs: 0, verifiedCharter: 'maybe' }), null);
  assert.deepEqual(normalizeSong({ title: 'Valid', artist: 4, noteCount: '1.5', combo: '', elapsedMs: -1, verifiedCharter: false }), { title: 'Valid', verifiedCharter: false });
});

test('Companion complete deterministic mock scenario keeps active metadata only in playing and paused', async () => {
  const { ServiceContainer, MockCloneHeroIntegration } = await modules;
  const mock = new MockCloneHeroIntegration();
  const container = new ServiceContainer({ integration: mock, initialWidgets: [widget()], logger: logger() });
  const snapshots = [];
  container.store.subscribe(() => {
    const state = container.store.getState();
    snapshots.push(state);
    if (!state.gameplay.isChartActive) assert.equal(state.nowPlaying, null);
  });
  assert.equal(container.store.getState().gameplay.state, 'idle');
  await container.start();
  assert.equal(container.store.getState().gameplay.state, 'menu');
  for (const state of ['loading', 'playing', 'paused', 'playing', 'results', 'menu']) {
    mock.step();
    const current = container.store.getState();
    assert.equal(current.gameplay.state, state);
    assert.equal(current.gameplay.isChartActive, state === 'playing' || state === 'paused');
    if (current.gameplay.isChartActive) {
      assert.deepEqual(current.nowPlaying, { songId: 'mock-everlong', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' });
    } else assert.equal(current.nowPlaying, null);
  }
  assert.ok((await mock.getCurrentSong()).title.includes('Everlong'), 'raw metadata stays present in menu');
  assert.equal(container.store.getState().widgets.instances[0].id, 'title-1');
  mock.transition('playing');
  mock.reset();
  assert.equal(container.store.getState().gameplay.state, 'menu');
  assert.equal(container.store.getState().nowPlaying, null);
  await container.stop();
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.ok(snapshots.length > 6);
  for (const snapshot of snapshots) {
    if (!snapshot.gameplay.isChartActive) assert.equal(snapshot.nowPlaying, null);
  }
});

test('Companion derives chart activity from real gameplay and ignores inactive song events', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  integration.state = { state: 'menu', isChartActive: true };
  const container = new ServiceContainer({ integration, logger: logger() });
  await container.start();
  assert.equal(container.store.getState().gameplay.isChartActive, false);
  integration.emit({ type: 'song', song: integration.song });
  integration.transition('loading');
  assert.equal(integration.songReads, 0);
  assert.equal(container.store.getState().nowPlaying, null);
  integration.emit({ type: 'gameplay', gameplay: { state: 'playing', isChartActive: false } });
  await flush();
  assert.equal(container.store.getState().gameplay.isChartActive, true);
  assert.equal(container.store.getState().nowPlaying.title, 'Everlong');
  await container.stop();
});

test('Companion discards song reads completed after menu or stop', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const reads = [];
  integration.getCurrentSong = () => { const read = deferred(); reads.push(read); return read.promise; };
  const container = new ServiceContainer({ integration, logger: logger() });
  await container.start();
  integration.transition('playing');
  integration.transition('menu');
  reads[0].resolve({ title: 'Stale after menu' });
  await flush();
  assert.equal(container.store.getState().nowPlaying, null);
  integration.transition('playing');
  await container.stop();
  assert.equal(container.store.getState().gameplay.state, 'idle');
  reads[1].resolve({ title: 'Stale after stop' });
  await flush();
  assert.equal(container.store.getState().nowPlaying, null);
  assert.equal(integration.listeners.size, 0);
});

test('Companion newer song events supersede older reads and missing capabilities stay absent', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const read = deferred();
  integration.getCurrentSong = () => read.promise;
  const container = new ServiceContainer({ integration, logger: logger() });
  await container.start();
  integration.transition('playing');
  integration.emit({ type: 'song', song: { title: ' New song ', artist: 'N/A', charter: null } });
  read.resolve({ title: 'Old song', artist: 'Old artist' });
  await flush();
  assert.deepEqual(container.store.getState().nowPlaying, { title: 'New song' });
  integration.emit({ type: 'song', song: {} });
  assert.equal(container.store.getState().nowPlaying, null);
  assert.equal(container.store.getState().gameplay.isChartActive, true);
  await container.stop();
});

test('Companion initial gameplay read cannot overwrite a newer live transition', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const snapshot = deferred();
  integration.getGameplayState = () => snapshot.promise;
  const container = new ServiceContainer({ integration, logger: logger() });
  const started = container.start();
  await flush();
  integration.transition('playing');
  snapshot.resolve({ state: 'menu', isChartActive: false });
  await started;
  assert.equal(container.store.getState().gameplay.state, 'playing');
  assert.equal(container.store.getState().nowPlaying.title, 'Everlong');
  await container.stop();
});

test('Companion stops and restarts without waiting for a stalled gameplay snapshot', { timeout: 5000 }, async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const snapshot = deferred();
  integration.getGameplayState = () => snapshot.promise;
  const container = new ServiceContainer({ integration, logger: logger() });
  const firstStart = container.start();
  await flush();
  await container.stop();
  assert.equal(integration.listeners.size, 0);
  integration.getGameplayState = async () => ({ state: 'menu', isChartActive: false });
  await container.start();
  snapshot.resolve({ state: 'playing', isChartActive: true });
  await firstStart;
  assert.equal(container.store.getState().gameplay.state, 'menu');
  assert.equal(container.store.getState().nowPlaying, null);
  await container.stop();
});

test('Companion lifecycle is idempotent, cleans listeners, and supports serialized restart', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const container = new ServiceContainer({ integration, logger: logger() });
  const start = container.start();
  assert.equal(container.start(), start);
  await start;
  assert.equal(integration.connections, 1);
  assert.equal(integration.listeners.size, 2);
  integration.transition('playing');
  await flush();
  const stop = container.stop();
  assert.equal(container.stop(), stop);
  assert.equal(container.store.getState().nowPlaying, null, 'clears before asynchronous disconnect');
  const restarted = container.start();
  await Promise.all([stop, restarted]);
  assert.equal(integration.connections, 2);
  assert.equal(integration.disconnections, 1);
  assert.equal(integration.listeners.size, 2);
  container.setWidgets([{ ...widget(), enabled: false }]);
  assert.equal(container.store.getState().widgets.instances[0].enabled, false);
  await container.stop();
  assert.equal(integration.listeners.size, 0);
  const stopped = container.store.getState();
  integration.emit({ type: 'song', song: { title: 'Late event' } });
  assert.equal(container.store.getState(), stopped);
  await container.stop();
  assert.equal(integration.disconnections, 2);
});

test('Companion cancellation during connection never starts services after stop', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const connection = deferred();
  integration.connect = () => { ++integration.connections; return connection.promise; };
  const container = new ServiceContainer({ integration, logger: logger() });
  const start = container.start();
  const stop = container.stop();
  connection.resolve();
  await Promise.all([start, stop]);
  assert.equal(integration.listeners.size, 0);
  assert.equal(integration.disconnections, 1);
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.equal(container.store.getState().serviceHealth.cloneHero.status, 'stopped');
});

test('Companion integration startup failures report safe health and allow retry', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const logs = logger();
  integration.connect = async () => { throw new Error('secret-token private-path'); };
  const container = new ServiceContainer({ integration, logger: logs });
  await assert.rejects(container.start(), /could not start/);
  assert.equal(container.store.getState().serviceHealth.cloneHero.status, 'error');
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.equal(integration.listeners.size, 0);
  assert.ok(logs.entries.some(entry => entry[1] === 'Service error'));
  assert.ok(!JSON.stringify([logs.entries, container.store.getState()]).includes('secret-token'));
  integration.connect = async () => { ++integration.connections; };
  await container.start();
  assert.equal(container.store.getState().serviceHealth.cloneHero.status, 'running');
  await container.stop();
});

test('Companion metadata failure remains isolated and recovers on fresh metadata', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  const logs = logger();
  integration.getCurrentSong = async () => { throw new Error('private source details'); };
  const container = new ServiceContainer({ integration, initialWidgets: [widget()], logger: logs });
  await container.start();
  integration.transition('playing');
  await flush();
  assert.equal(container.store.getState().gameplay.state, 'playing');
  assert.equal(container.store.getState().serviceHealth.nowPlaying.status, 'error');
  assert.equal(container.store.getState().nowPlaying, null);
  assert.equal(container.store.getState().widgets.instances.length, 1);
  integration.emit({ type: 'song', song: { title: 'Recovered' } });
  assert.equal(container.store.getState().nowPlaying.title, 'Recovered');
  assert.equal(container.store.getState().serviceHealth.nowPlaying.status, 'running');
  integration.emit({ type: 'error' });
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.equal(container.store.getState().nowPlaying, null);
  assert.equal(container.store.getState().serviceHealth.gameplay.status, 'error');
  await container.stop();
});

test('Companion failed initial gameplay read can recover from integration events', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  integration.getGameplayState = async () => { throw new Error('unavailable'); };
  const container = new ServiceContainer({ integration, logger: logger() });
  await container.start();
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.equal(container.store.getState().serviceHealth.gameplay.status, 'error');
  integration.transition('playing');
  await flush();
  assert.equal(container.store.getState().serviceHealth.gameplay.status, 'running');
  assert.equal(container.store.getState().nowPlaying.title, 'Everlong');
  await container.stop();
});

test('Companion disconnect failure logs health while clearing state and subscribers', async () => {
  const { ServiceContainer } = await modules;
  const integration = new FakeIntegration();
  integration.disconnect = async () => { throw new Error('transport disconnect'); };
  const logs = logger();
  const container = new ServiceContainer({ integration, logger: logs });
  await container.start();
  integration.transition('playing');
  await flush();
  await container.stop();
  assert.equal(integration.listeners.size, 0);
  assert.equal(container.store.getState().nowPlaying, null);
  assert.equal(container.store.getState().gameplay.state, 'idle');
  assert.equal(container.store.getState().serviceHealth.cloneHero.status, 'error');
  assert.ok(logs.entries.some(entry => entry[1] === 'Service error'));
});
