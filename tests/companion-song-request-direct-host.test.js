'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const security = require('../companion/security.cjs');
const { createSongRequestConnections } = require('../companion/song-request-connections.cjs');
const { replyFor } = require('../companion/song-request-server.cjs');

// Execute the host's real lifecycle and IPC wiring with synthetic providers.
// Nothing here opens Electron, a chat connection, user settings or a Songs tree.
const source = fs.readFileSync(path.join(__dirname, '../companion/host.cjs'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing host orchestration: ${start}`);
  return source.slice(from, to);
}
const wiring = section('  songRequestConnections = createSongRequestConnections(', '  async function configureSongRequests(');
const configure = section('  async function configureSongRequests(', '  async function refreshSongRequestShare(');
const libraryChanged = section('    musicPlayer?.libraryChanged();', '  } });\n  await library.load();');
const commands = section("  ipcMain.handle('companion:command',", '  function stop()');
const stopping = section('  function stop()', '  function open()');
const panelAlive = section('  function panelAlive()', '  function catalogueAllowed()');
const rules = { maxDurationMinutes: null, instrument: 'all', difficulty: 'all' };
const enable = () => ({ enabled: true, port: 38474, rules: { ...rules } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const idle = () => new Promise(resolve => setImmediate(resolve));

function inProcessBridge(options) {
  let listener;
  class HttpServer extends EventEmitter {
    constructor(callback) { super(); listener = callback; }
    listen(_port, _address, callback) { callback(); }
    address() { return { port: 38475 }; }
    close(callback) { callback(); }
  }
  const module = { exports: {} };
  // Only the socket transport is synthetic; parsing, authentication, host checks,
  // callback routing and response formatting run the actual server module.
  new vm.Script(fs.readFileSync(path.join(__dirname, '../companion/song-request-server.cjs'), 'utf8'), {
    filename: 'companion/song-request-server.cjs synthetic HTTP transport'
  }).runInNewContext({ module, Buffer, TextDecoder, URL,
    require: name => name === 'node:http' ? { createServer: (_options, callback) => new HttpServer(callback) } : require(name) });
  const server = module.exports.createSongRequestServer(options);
  return { server, post(input) {
    const body = Buffer.from(JSON.stringify(input));
    const request = Readable.from([body]);
    Object.assign(request, { url: '/song-requests', method: 'POST',
      headers: { host: '127.0.0.1:38475', authorization: 'Bearer ' + 'c'.repeat(64), 'content-type': 'application/json', 'content-length': String(body.length) },
      rawHeaders: ['Host', '127.0.0.1:38475', 'Authorization', 'Bearer ' + 'c'.repeat(64), 'Content-Type', 'application/json', 'Content-Length', String(body.length)] });
    return new Promise(resolve => {
      const response = { destroyed: false, writeHead(status) { this.status = status; },
        end(value) { resolve({ status: this.status, body: JSON.parse(value) }); } };
      listener(request, response);
    });
  } };
}

function fixture({ save, start, consent = false, receive } = {}) {
  const received = [], sent = [], events = [], providers = {};
  const state = { enabled: false, rules: { ...rules }, requests: [] };
  const libraryState = { status: 'ready', count: 1, revision: 1 };
  const stopped = { bridge: 0, twitch: 0, tiktok: 0, flush: 0 };
  let bridgeEnabled = false, bridgeError = null;
  const bridge = {
    status: () => ({ enabled: bridgeEnabled, port: 38474, error: bridgeError }),
    setPort() {},
    async start(port) { events.push('bridge-start'); if (start) await start(port); bridgeError = 'Port unavailable'; return this.status(); },
    async stop() { stopped.bridge++; bridgeEnabled = false; return this.status(); }
  };
  const provider = platform => options => {
    let status = { state: 'disconnected', displayName: null, error: null }, active = false, release;
    const transport = {
      status: () => ({ ...status }),
      async connect() {
        status = { state: consent && platform === 'twitch' ? 'authorizing' : 'connected', displayName: 'Synthetic', error: null };
        if (consent && platform === 'twitch') await new Promise(resolve => { release = resolve; });
        return status;
      },
      async setReceiving(value) { active = value; events.push(`${platform}:${value}`); },
      async stop() { stopped[platform]++; active = false; status = { state: 'disconnected', displayName: null, error: null }; release?.(); },
      async disconnect() { return this.stop(); },
      async sendReply(message) { sent.push({ platform, message }); return { ok: true }; },
      setState(value) { status = { ...status, state: value }; },
      message(id = 'synthetic-event') { options.onMessage({ platform, eventId: id, viewerId: '42', viewerName: 'Synthetic viewer', query: '!queue' }); },
      receiving: () => active
    };
    providers[platform] = transport; return transport;
  };
  const adapters = {
    songRequests: {
      configure(patch) { Object.assign(state, patch); return structuredClone(state); },
      snapshot: () => structuredClone(state),
      async receive(input) { received.push(input); return receive ? receive(input) : { ok: true, command: 'queue', items: [] }; }
    },
    library: { status: () => ({ ...libraryState }), matchingSnapshot:()=>({rootKey:libraryState.rootKey??'synthetic-root'}), stop: async () => {} },
    songRequestAccounts: { status: () => ({ persistent: true, error: null }), flush: async () => { stopped.flush++; } },
    songRequestPreferences: { save: save ?? (async () => {}), flush: async () => {} },
    songRequestConnectionOptions: { createTwitch: provider('twitch'), createTikTok: provider('tiktok') },
    createSongRequestServer: options => { bridge.receive = options.receive; return bridge; }
  };
  const create = new vm.Script(`(function(adapters) {
    const {songRequests,library,songRequestAccounts,songRequestPreferences,songRequestConnectionOptions,createSongRequestServer}=adapters;
    let disposing=false,stopTask=null,hostActive=true,lifecycleRevision=0,songRequestBusy=false;
    let songRequestServer=null,songRequestConnections=null;
    const publishedTwitchClientId='syntheticclient',shell={openExternal:async()=>{}},language='fr',publishPanel=()=>{};
    const requestPreferences={ingestToken:'a'.repeat(64),readToken:'b'.repeat(64),error:null,port:38474};
    const services={stop:async()=>{},store:{getState:()=>({widgets:{instances:[]}})}};
    let libraryIndexRevision=1,libraryRequestRoot='synthetic-root',libraryDownloadRefresh=null,songRequestShareManualBusy=null;
    const catalogue={libraryChanged:()=>{},stop:async()=>{}},downloads={stop:async()=>{}},musicPlayer=null;
    let playerWindow=null,playerWindowLoad=null,catalogueWidget=null,catalogueWidgetLoad=null,catalogueWidgetEnabled=false,catalogueWidgetTicket=0;
    let filtersTimer=null,filtersWidget=null,filtersWidgetLoad=null,filtersWidgetEnabled=false,overlay=null,overlayLoad=null,overlayEnabled=false;
    const unregisterCatalogueShortcut=()=>{},setStream=async()=>{},reshadeSetup={status:()=>({state:'idle'})};
    let saveTimer=null,songRequestShareRevision=0,songRequestShareController=null,songRequestShareSync=null,songRequestShare={busy:false},playerPreferencesTask=Promise.resolve(),pendingSave=Promise.resolve(),cleanupTask=null,filtersRefresh=null,reshadeRefresh=null,logTail=Promise.resolve();
    const playerPreferences={flush:async()=>{}},floatingPanels={flush:async()=>{}},profileWrites=[];
    const panelFrame={url:'chartshub-companion://app/ui/index.html'},panelContents={mainFrame:panelFrame,isDestroyed:()=>false},panel={isDestroyed:()=>false};
    ${panelAlive}
    const trustedPanel=event=>panelAlive()&&trustedContentsSender(event,panelContents,'index.html');
    const trustedPlayer=()=>false,catalogueAllowed=()=>false,editorRevision=0;
    const ipcMain={handle:(_channel,handler)=>{commandHandler=handler;}}; let commandHandler;
    ${wiring}
    ${configure}
    function libraryChange(){ ${libraryChanged} }
    ${commands}
    ${stopping}
    return {configure:configureSongRequests,stop,libraryChange,connections:()=>songRequestConnections.status(),
      invoke:(command,payload,event={sender:panelContents,senderFrame:panelFrame})=>commandHandler(event,command,payload),
      event:()=>({sender:panelContents,senderFrame:panelFrame}),panelContents};
  })`, { filename: 'companion/host.cjs native Song Request lifecycle' }).runInNewContext({
    ...security, createSongRequestConnections, structuredClone, clearInterval, __dirname: path.join(__dirname, '../companion')
  });
  return { host: create(adapters), state, libraryState, received, sent, stopped, bridge, providers, events };
}

test('native reception remains usable when the optional localhost bridge port is occupied', async () => {
  const f = fixture(); await f.host.invoke('songRequests.connect', { platform: 'twitch' }); await idle();
  assert.equal((await f.host.configure(enable())).ok, true); await idle();
  assert.equal(f.state.enabled, true); assert.equal(f.bridge.status().enabled, false);
  assert.equal(f.providers.twitch.receiving(), true);
  f.providers.twitch.message(); await idle();
  assert.equal(f.received.length, 1); assert.deepEqual(f.sent, [{ platform: 'twitch', message: 'La file est vide.' }]);
  await f.host.stop();
});

test('closing during a preference write prevents an old enable request from starting providers', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  const enabling = f.host.configure(enable()); await idle();
  const closed = f.host.stop(); gate.resolve();
  assert.equal((await enabling).ok, false); await closed;
  assert.equal(f.state.enabled, false); assert.equal(f.providers.twitch.receiving(), false);
  assert.equal(f.events.includes('bridge-start'), false); assert.equal(f.stopped.flush, 1);
});

test('closing during bridge startup cannot reopen the queue or the direct transports', async () => {
  const gate = deferred(), entered = deferred(), f = fixture({ start: () => { entered.resolve(); return gate.promise; } });
  const enabling = f.host.configure(enable()); await entered.promise;
  const closed = f.host.stop(); gate.resolve();
  assert.equal((await enabling).ok, false); await closed;
  assert.equal(f.state.enabled, false); assert.equal(f.providers.twitch.receiving(), false);
});

test('library loss during awaited setup prevents reception from being reenabled', async () => {
  for (const pending of ['preferences', 'bridge']) {
    const gate = deferred(), entered = deferred(), wait = () => { entered.resolve(); return gate.promise; };
    const f = fixture(pending === 'preferences' ? { save: wait } : { start: wait });
    const enabling = f.host.configure(enable()); await entered.promise;
    f.libraryState.status = 'unavailable'; f.libraryState.count = 0; f.host.libraryChange(); gate.resolve();
    assert.equal((await enabling).ok, false, `${pending} cannot enable an unavailable library`);
    assert.equal(f.state.enabled, false); assert.equal(f.providers.twitch.receiving(), false);
    await f.host.stop();
  }
});

test('an active library becoming unavailable fences incoming events before asynchronous shutdown', async () => {
  const f = fixture(); await f.host.invoke('songRequests.connect', { platform: 'twitch' }); await idle();
  await f.host.configure(enable()); await idle();
  f.libraryState.status = 'unavailable'; f.host.libraryChange();
  assert.equal(f.state.enabled, false); assert.equal(f.providers.twitch.receiving(), false);
  f.providers.twitch.message(); await idle();
  assert.equal(f.received.length, 0); assert.equal(f.sent.length, 0); assert.ok(f.stopped.bridge > 0);
  await f.host.stop();
});

test('a background scan keeps reception selected, fences commands while scanning and resumes without reconnecting',async()=>{
  const f=fixture();await f.host.invoke('songRequests.connect',{platform:'twitch'});await idle();await f.host.configure(enable());await idle();
  f.libraryState.status='scanning';f.host.libraryChange();
  assert.equal(f.state.enabled,true);assert.equal(f.providers.twitch.receiving(),true);
  f.providers.twitch.message();await idle();assert.equal(f.received.length,0);
  f.libraryState.status='ready';f.libraryState.revision++;f.host.libraryChange();f.providers.twitch.message();await idle();
  assert.equal(f.state.enabled,true);assert.equal(f.received.length,1);assert.equal(f.stopped.twitch,0);
  f.libraryState.status='scanning';f.host.libraryChange();await f.host.configure({...enable(),enabled:false});
  f.libraryState.status='ready';f.host.libraryChange();assert.equal(f.state.enabled,false);assert.equal(f.providers.twitch.receiving(),false);
  await f.host.stop();
});

test('a scan in a changed Songs root never preserves reception from the previous root',async()=>{
  const f=fixture();await f.host.configure(enable());await idle();f.libraryState.rootKey='different-root';f.libraryState.status='scanning';f.host.libraryChange();
  assert.equal(f.state.enabled,false);f.libraryState.status='ready';f.host.libraryChange();assert.equal(f.state.enabled,false);await f.host.stop();
});

test('Twitch consent never holds the IPC handler open and closes with the host', async () => {
  const f = fixture({ consent: true });
  assert.equal((await f.host.invoke('songRequests.connect', { platform: 'twitch' })).ok, true);
  assert.equal(f.host.connections().twitch.state, 'authorizing');
  await f.host.stop(); await idle();
  assert.equal(f.host.connections().twitch.state, 'disconnected');
  assert.equal(f.stopped.twitch, 1); assert.equal(f.stopped.tiktok, 1);
  assert.equal((await f.host.invoke('songRequests.connect', { platform: 'twitch' })).ok, false);
});

test('native account commands accept only bounded platform data from the exact main panel frame', async () => {
  const f = fixture(), event = f.host.event();
  for (const page of ['overlay.html', 'filters-widget.html', 'catalogue-widget.html', 'music-player.html']) {
    const frame = { url: 'chartshub-companion://app/ui/' + page }, contents = { mainFrame: frame };
    for (const command of ['songRequests.connect', 'songRequests.disconnect', 'songRequests.cancelAuth']) {
      assert.equal((await f.host.invoke(command, { platform: 'twitch' }, { sender: contents, senderFrame: frame })).ok, false);
    }
  }
  for (const forged of [
    { ...event, senderFrame: { url: event.senderFrame.url } },
    { ...event, sender: { mainFrame: event.senderFrame } }
  ]) assert.equal((await f.host.invoke('songRequests.connect', { platform: 'twitch' }, forged)).ok, false);
  for (const payload of [null, [], {}, { platform: 'youtube' }, { platform: 'twitch', token: 'private' }, { platform: 'tiktok', username: '../outside' }, { platform: 'tiktok', username: '@user', url: 'https://outside.invalid' }]) {
    assert.equal((await f.host.invoke('songRequests.connect', payload)).ok, false);
  }
  assert.equal(f.host.connections().twitch.state, 'disconnected');
  assert.equal((await f.host.invoke('songRequests.connect', { platform: 'tiktok', username: '@synthetic_user' })).ok, true);
  await f.host.stop();
});

test('a queue result arriving after shutdown never publishes or sends its old chat response', async () => {
  const gate = deferred(), entered = deferred(), f = fixture({ receive: () => { entered.resolve(); return gate.promise; } });
  await f.host.invoke('songRequests.connect', { platform: 'twitch' }); await idle();
  await f.host.configure(enable()); await idle(); f.providers.twitch.message(); await entered.promise;
  const stopping = f.host.stop(); gate.resolve({ ok: true, command: 'queue', items: [] }); await stopping;
  assert.equal(f.received.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.host.connections().lastResponse, null);
});

test('an installed Streamer.bot action stays silent while native Twitch handles the same command once', async t => {
  const f = fixture(); await f.host.invoke('songRequests.connect', { platform: 'twitch' }); await idle();
  await f.host.configure(enable()); await idle();
  const { server, post } = inProcessBridge({ root: path.join(__dirname, '../companion'), ingestToken: 'c'.repeat(64), readToken: 'd'.repeat(64),
    receive: input => f.bridge.receive(input), getSnapshot: () => f.state });
  await server.start(0); t.after(async () => { await server.stop(); await f.host.stop(); });
  const input = { platform: 'twitch', eventId: 'same-synthetic-id', viewerId: '42', viewerName: 'Synthetic viewer', message: '!queue' };
  const legacy = async () => {
    const response = await post(input);
    assert.equal(response.status, 200); return response.body;
  };
  // Either delivery order must keep the legacy action from executing/replying.
  assert.equal((await legacy()).reply, '');
  f.providers.twitch.message(input.eventId); await idle();
  assert.equal((await legacy()).reply, '');
  assert.equal(f.received.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message, 'La file est vide.');
});

test('the existing bridge resumes handling commands when native Twitch fails or is disconnected', async () => {
  for (const unavailable of ['error', 'disconnect']) {
    const f = fixture(); await f.host.invoke('songRequests.connect', { platform: 'twitch' }); await idle();
    await f.host.configure(enable()); await idle();
    if (unavailable === 'disconnect') await f.host.invoke('songRequests.disconnect', { platform: 'twitch' });
    else f.providers.twitch.setState('error');
    const result = await f.bridge.receive({ platform: 'twitch', eventId: 'legacy-synthetic-id', viewerId: '42', viewerName: 'Synthetic viewer', query: '!queue' });
    assert.equal(replyFor(result), 'La file est vide.'); assert.equal(f.received.length, 1);
    f.providers.twitch.message('native-after-error'); await idle();
    assert.equal(f.received.length, 1); assert.equal(f.sent.length, 0);
    await f.host.stop();
  }
});
