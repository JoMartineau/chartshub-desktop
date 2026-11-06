'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { rootContext, readJsonFile, identity } = require('./download-worker.cjs');
const { syncError, ENDPOINT } = require('./catalogue-sync-client.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// A bounded page and its append-only journal are the largest objects rewritten.
// Installed provenance is sharded by source, independent of download history.
function createCatalogueSyncStore({ dataDirectory }) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw syncError('SYNC_STORAGE');
  const directory = path.join(dataDirectory, 'catalogue-sync'); let context, loading;
  const membership = new Map();
  async function init() {
    if (context) return; if (loading) return loading;
    loading = (async () => { await fs.mkdir(directory, { recursive: true }); context = await rootContext(directory); })();
    try { await loading; } finally { loading = null; }
  }
  function target(relative) {
    if (typeof relative !== 'string' || !/^[a-zA-Z0-9./_-]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw syncError('SYNC_STORAGE');
    return path.join(directory, ...relative.split('/'));
  }
  async function read(relative, limit = 2 * 1024 * 1024) {
    await init(); const filename = target(relative);
    try { await context.guard(); await fs.lstat(filename); return await readJsonFile(context, filename, limit); }
    catch (problem) { if (problem.code === 'ENOENT') return null; throw syncError('SYNC_STORAGE'); }
  }
  async function write(relative, value) {
    await init(); const filename = target(relative), bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw syncError('SYNC_STORAGE');
    if (path.dirname(filename) !== directory) await context.mkdir(path.dirname(filename));
    await context.checked(filename, { missing: true });
    const temporary = filename + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await context.guard(); await context.checked(filename, { missing: true }); await fs.rename(temporary, filename);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  function pageName(job, number) {
    if (!UUID.test(job) || !Number.isInteger(number) || number < 0 || number > 200000) throw syncError('SYNC_STORAGE');
    return `plans/${job}/${String(number).padStart(6, '0')}`;
  }
  async function savePage(job, number, items) { await write(pageName(job, number) + '.json', { version: 1, items }); }
  async function loadPage(job, number) {
    const base = pageName(job, number), data = await read(base + '.json');
    if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > 500) throw syncError('SYNC_STORAGE');
    await init(); const journal = target(base + '.jsonl');
    let stat; try { await fs.lstat(journal); stat = await context.checked(journal); } catch (problem) { if (problem.code === 'ENOENT') return data.items; throw syncError('SYNC_STORAGE'); }
    if (stat.size > 4 * 1024 * 1024) throw syncError('SYNC_STORAGE');
    const handle = await fs.open(journal, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(stat)) throw syncError('SYNC_STORAGE');
      const bytes = await handle.readFile('utf8'), lines = bytes.split('\n');
      // A process may stop in the middle of its final append. Earlier durable
      // events remain authoritative; that final task will be revalidated.
      for (let n = 0; n < lines.length - 1; n++) {
        if (!lines[n]) continue;
        const event = JSON.parse(lines[n]);
        if (!Number.isInteger(event.index) || event.index < 0 || event.index >= data.items.length || !['completed', 'failed', 'conflict', 'unchanged'].includes(event.state)) throw syncError('SYNC_STORAGE');
        Object.assign(data.items[event.index], { state: event.state, error: typeof event.error === 'string' ? event.error.slice(0, 100) : null, receivedBytes: Number.isSafeInteger(event.receivedBytes) && event.receivedBytes >= 0 ? event.receivedBytes : 0 });
      }
    } catch { throw syncError('SYNC_STORAGE'); } finally { await handle.close(); }
    return data.items;
  }
  async function append(job, number, event) {
    await init(); const filename = target(pageName(job, number) + '.jsonl');
    const before = await context.checked(filename, { missing: true });
    // Trim an interrupted final append before adding the next complete record.
    if (before) {
      if (before.size > 4 * 1024 * 1024) throw syncError('SYNC_STORAGE');
      const file = await fs.open(filename, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
      try {
        if (identity(await file.stat({ bigint: true })) !== identity(before)) throw syncError('SYNC_STORAGE');
        const length = Math.min(before.size, 4096), tail = Buffer.alloc(length);
        await file.read(tail, 0, length, before.size - length);
        if (length && tail.at(-1) !== 10) {
          const newline = tail.lastIndexOf(10);
          if (newline < 0 && length < before.size) throw syncError('SYNC_STORAGE');
          await file.truncate(before.size - length + newline + 1);
        }
      } finally { await file.close(); }
    }
    const handle = await fs.open(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (before && identity(await handle.stat({ bigint: true })) !== identity(before)) throw syncError('SYNC_STORAGE');
      await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync();
    } finally { await handle.close(); }
  }
  function recordName(rootPath, endpoint) {
    if (!path.isAbsolute(rootPath) || !ENDPOINT.test(endpoint)) throw syncError('SYNC_INVALID');
    const key = digest(endpoint), rootKey = digest(process.platform === 'win32' ? path.resolve(rootPath).toLowerCase() : path.resolve(rootPath));
    return `installed/${rootKey}/${key.slice(0, 2)}/${key}.json`;
  }
  async function recordKeys(relative) {
    const prefix = relative.split('/').slice(0, 2).join('/');
    if (membership.has(prefix)) return membership.get(prefix);
    await init(); await context.guard(); const keys = new Set(), folder = target(prefix);
    try {
      await fs.lstat(folder); await context.checked(folder, { directory: true });
      for (const shard of await fs.readdir(folder, { withFileTypes: true })) {
        if (!/^[a-f0-9]{2}$/.test(shard.name)) continue;
        const shardPath = path.join(folder, shard.name); await context.checked(shardPath, { directory: true });
        for (const file of await fs.readdir(shardPath, { withFileTypes: true })) if (/^[a-f0-9]{64}\.json$/.test(file.name)) keys.add(`${prefix}/${shard.name}/${file.name}`);
      }
    } catch (problem) { if (problem.code !== 'ENOENT') throw syncError('SYNC_STORAGE'); }
    membership.set(prefix, keys); return keys;
  }
  const protect = fn => async (...args) => { try { return await fn(...args); } catch (problem) { if (problem?.code === 'SYNC_INVALID') throw problem; throw syncError('SYNC_STORAGE'); } };
  return { readState: protect(() => read('state.json')), writeState: protect(value => write('state.json', value)),
    savePage: protect(savePage), loadPage: protect(loadPage), append: protect(append),
    readRecord: protect(async (root, endpoint) => { const name = recordName(root, endpoint); return (await recordKeys(name)).has(name) ? read(name) : null; }),
    writeRecord: protect(async (root, endpoint, value) => { const name = recordName(root, endpoint), keys = await recordKeys(name); await write(name, value); keys.add(name); }) };
}
module.exports = { createCatalogueSyncStore, UUID, digest };
