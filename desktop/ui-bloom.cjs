'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const PANEL_URL = 'chartshub-companion://app/ui/index.html';
const READ = 'chartshub-ui-bloom:read', SAVE = 'chartshub-ui-bloom:save', READY = 'chartshub-ui-bloom:ready';

// Does not make the Companion's intentionally ephemeral Electron session persistent.
async function createUIBloomStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw TypeError('Invalid bloom directory');
  const model = await import('../companion/ui/ui-bloom-model.js');
  const filename = path.join(directory, 'ui-bloom.json');
  async function ordinaryFile() {
    try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe bloom file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    async read() {
      let handle;
      try {
        await ordinaryFile();
        handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 2048) return { settings: model.normalize(), warning: 'invalid' };
        const buffer = Buffer.alloc(2049), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 2048) return { settings: model.normalize(), warning: 'invalid' };
        let value;
        try { value = model.validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))); } catch { /* Preserve malformed files until explicit Apply. */ }
        return value ? { settings: value } : { settings: model.normalize(), warning: 'invalid' };
      } catch (error) {
        if (error.code === 'ENOENT') return { settings: model.normalize() };
        throw error;
      } finally { if (handle) await handle.close(); }
    },
    async save(value) {
      const settings = model.validate(value);
      if (!settings) throw TypeError('Invalid bloom settings');
      await fs.mkdir(directory, { recursive: true });
      await ordinaryFile();
      const temporary = path.join(directory, '.ui-bloom-' + randomUUID() + '.tmp');
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(settings) + '\n', 'utf8');
        await handle.sync(); await handle.close(); handle = null;
        await ordinaryFile();
        await fs.rename(temporary, filename);
        return settings;
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    }
  };
}

function createUIBloomIpc({ ipcMain, getContents, isAvailable, getDirectory, createStore = createUIBloomStore }) {
  let disposed = false, busy = false, pending = Promise.resolve(), storePromise;
  function trusted(event) {
    try {
      const contents = getContents();
      return !disposed && isAvailable() && contents && !contents.isDestroyed()
        && event?.sender === contents && event.senderFrame === contents.mainFrame
        && event.senderFrame?.url === PANEL_URL && contents.getURL() === PANEL_URL;
    } catch { return false; }
  }
  function store() {
    if (!storePromise) storePromise = Promise.resolve().then(() => createStore(getDirectory())).catch(error => { storePromise = null; throw error; });
    return storePromise;
  }
  function run(event, action, payload) {
    if (!trusted(event)) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (action === 'read' && payload !== undefined) return Promise.resolve({ ok: false, error: 'invalid' });
    if (busy) return Promise.resolve({ ok: false, error: 'busy' });
    busy = true;
    pending = (async () => {
      try {
        const model = await import('../companion/ui/ui-bloom-model.js');
        const settings = action === 'save' ? model.validate(payload) : null;
        if (action === 'save' && !settings) return { ok: false, error: 'invalid' };
        const nativeStore = await store();
        if (!trusted(event)) return { ok: false, error: 'unavailable' };
        const result = action === 'save' ? { settings: await nativeStore.save(settings) } : await nativeStore.read();
        return trusted(event) ? { ok: true, ...result } : { ok: false, error: 'unavailable' };
      } catch { return { ok: false, error: 'storage' }; }
      finally { busy = false; }
    })();
    return pending;
  }
  ipcMain.handle(READ, (event, payload) => run(event, 'read', payload));
  ipcMain.handle(SAVE, (event, payload) => run(event, 'save', payload));
  return {
    notifyReady(contents) {
      try {
        if (trusted({ sender: contents, senderFrame: contents.mainFrame })) contents.send(READY);
      } catch { /* View was destroyed or navigated away. */ }
    },
    dispose() {
      if (!disposed) { disposed = true; ipcMain.removeHandler(READ); ipcMain.removeHandler(SAVE); }
      return pending.then(() => undefined);
    }
  };
}
module.exports = { createUIBloomStore, createUIBloomIpc };
