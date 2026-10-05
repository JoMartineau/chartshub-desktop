'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Module, createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const PANEL = 'chartshub-companion://app/ui/index.html';
const READ = 'chartshub-ui-bloom:read', SAVE = 'chartshub-ui-bloom:save', READY = 'chartshub-ui-bloom:ready';
async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-bloom-shell-'));
  const handlers = new Map();
  class Web extends EventEmitter {
    constructor() { super(); this.url = ''; this.mainFrame = { url: '' }; this.sent = []; this.dead = false; this.session = new EventEmitter(); this.session.setPermissionRequestHandler = this.session.setPermissionCheckHandler = () => {}; }
    getURL() { return this.url; } isDestroyed() { return this.dead; } isLoading() { return false; }
    setWindowOpenHandler() {} setZoomFactor() {} focus() {} setVisualZoomLevelLimits() { return Promise.resolve(); }
    send(channel) { this.sent.push(channel); } close() { this.dead = true; this.emit('destroyed'); }
    finish(url) { this.url = this.mainFrame.url = url; this.emit('did-finish-load'); this.emit('did-stop-loading'); }
  }
  class View { constructor() { this.webContents = new Web(); } setVisible() {} setBounds() {} }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new Web(); this.contentView = { addChildView() {}, removeChildView() {} }; }
    setMenuBarVisibility() {} getContentSize() { return [1400,950]; } isDestroyed() { return false; }
    loadFile(file) { return Promise.resolve().then(() => this.webContents.finish(pathToFileURL(file).href)); }
  }
  const electron = { app: { getPath: () => directory }, BrowserWindow: Window, WebContentsView: View, ipcMain: { handle: (n,f) => { assert.equal(handlers.has(n),false); handlers.set(n,f); }, removeHandler: n => handlers.delete(n) } };
  const filename = require.resolve('../desktop/controller.cjs'), mod = new Module(filename,module), normal = createRequire(filename);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod.require = n => n === 'electron' ? electron : normal(n);
  mod._compile(fs.readFileSync(filename,'utf8'),filename);
  const shell = mod.exports.createDesktopShell(); await shell.ready;
  t.after(async () => { await shell.dispose(); await fsp.rm(directory,{recursive:true,force:true}); });
  const companion = new View(); companion.webContents.finish(PANEL);
  const event = () => ({sender:companion.webContents,senderFrame:companion.webContents.mainFrame});
  return { shell, companion, handlers, event, directory };
}
test('bloom IPC starts at attachment, restores on reload and never grants catalogue access', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.handlers.keys()].sort(),['chartshub-shell:select-tab','chartshub-shell:state']);
  f.shell.setCompanionAvailable(true); f.shell.attachCompanion(f.companion);
  assert.equal(f.companion.webContents.sent.at(-1),READY);
  const read = f.handlers.get(READ);
  assert.equal((await read(f.event())).ok,true);
  const web = f.shell.catalogueView.webContents;
  assert.equal((await read({sender:web,senderFrame:web.mainFrame})).ok,false);
  const count=f.companion.webContents.sent.length; f.companion.webContents.finish(PANEL);
  assert.equal(f.companion.webContents.sent.length,count+1);
});
test('native Companion Apply persists outside ephemeral session; logout blocks edits', async t => {
  const f=await fixture(t), m=await import('../companion/ui/ui-bloom-model.js');
  f.shell.setCompanionAvailable(true);f.shell.attachCompanion(f.companion);
  const value={...m.DEFAULTS,enabled:true,color:'#ff7700'};
  assert.equal((await f.handlers.get(SAVE)(f.event(),value)).ok,true);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.directory,'companion/ui-bloom.json'),'utf8')),value);
  f.shell.setCompanionAvailable(false);
  assert.equal((await f.handlers.get(SAVE)(f.event(),{...value,color:'#00ff00'})).ok,false);
  f.shell.setCompanionAvailable(true);
  assert.deepEqual((await f.handlers.get(READ)(f.event())).settings,value);
});
test('shell disposal removes bloom handlers and returns the pending persistence barrier', async t => {
  const f=await fixture(t);f.shell.setCompanionAvailable(true);f.shell.attachCompanion(f.companion);
  const done=f.shell.dispose();assert.equal(typeof done?.then,'function'); await done;
  assert.equal(f.handlers.size,0);assert.equal(f.shell.dispose(),done);
});
