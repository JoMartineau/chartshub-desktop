'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto'), { inflateRaw, crc32 } = require('node:zlib');
const { promisify } = require('node:util');
const inflate = promisify(inflateRaw);
const MT_VERSION = '2.1.5.1';
const MT_URL = 'https://cdn1.resources.manda-audio.com/DOWNLOADS/products/mtpdk2_free/2.1.5/MTPDK-2.1.5.1-VST3-64bit-Windows-FULL.zip';
const MT_LICENSE_URL = 'https://www.powerdrumkit.com/EULA.php?lang=en';
const MAX_ZIP_BYTES = 80 * 1024 * 1024, MAX_DECODED_BYTES = 256 * 1024 * 1024, MAX_ENTRIES = 100;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code = 'DRUM_MT_ARCHIVE') => Object.assign(Error(code), { code });
function range(bytes, offset, length, end = bytes.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || end > bytes.length || offset + length > end) throw fail();
}
function relative(name, directory = false) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\:\x00-\x1f\x7f<>"|?*]/.test(name)) throw fail();
  const clean = directory && name.endsWith('/') ? name.slice(0, -1) : name, parts = clean.split('/');
  if (parts.length > 10 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail();
  return clean;
}
function extras(bytes, offset, length) {
  const end = offset + length;
  while (offset < end) { range(bytes, offset, 4, end); const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); range(bytes, offset + 4, size, end); if (id === 1) throw fail(); offset += 4 + size; }
}
function peX64(bytes) {
  range(bytes, 0, 64); if (bytes.toString('ascii', 0, 2) !== 'MZ') throw fail();
  const header = bytes.readUInt32LE(60); range(bytes, header, 26);
  if (header < 64 || bytes.readUInt32LE(header) !== 0x4550 || bytes.readUInt16LE(header + 4) !== 0x8664
      || bytes.readUInt16LE(header + 24) !== 0x20b || !(bytes.readUInt16LE(header + 22) & 0x2000)) throw fail();
  const optionalSize = bytes.readUInt16LE(header + 20); if (optionalSize < 112) throw fail(); range(bytes, header + 24, optionalSize);
}
/** ZIP bytes are never executed. Strict Windows paths and central/local headers
 * are checked before extraction; supplied readmes/licences remain unchanged. */
async function inspectMtArchive(bytes, signal) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) throw fail();
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw fail();
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
      || count < 2 || count > MAX_ENTRIES || central === 0xffffffff || centralSize === 0xffffffff || central + centralSize !== end) throw fail();
  const entries = [], names = new Set(); let cursor = central, total = 0;
  for (let index = 0; index < count; index++) {
    range(bytes, cursor, 46, end); if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw fail();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32), attributes = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    range(bytes, cursor + 46, nameSize + extraSize + commentSize, end);
    if (nameSize < 1 || nameSize > 512 || flags & ~(0x0808 | (method === 8 ? 0x0006 : 0)) || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34)
        || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff || compressed > MAX_ZIP_BYTES || size > MAX_DECODED_BYTES) throw fail();
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { throw fail(); }
    const directory = name.endsWith('/'), relativePath = relative(name, directory), key = relativePath.toLowerCase(), fileType = (attributes >>> 16) & 0xf000;
    if (names.has(key) || ![0, 0x8000, 0x4000].includes(fileType) || fileType === 0x4000 && !directory || fileType === 0x8000 && directory || (attributes & 16) && !directory || directory && (size || crc || method === 0 && compressed)) throw fail();
    names.add(key); total += size; if (total > MAX_DECODED_BYTES) throw fail();
    extras(bytes, cursor + 46 + nameSize, extraSize);
    range(bytes, local, 30, central);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw fail();
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    range(bytes, local + 30, localName + localExtra, central);
    if (localName !== nameSize || !rawName.equals(bytes.subarray(local + 30, local + 30 + localName))) throw fail();
    extras(bytes, local + 30 + localName, localExtra);
    for (const [offset, expected] of [[14, crc], [18, compressed], [22, size]]) { const actual = bytes.readUInt32LE(local + offset); if (actual !== expected && (!(flags & 8) || actual !== 0)) throw fail(); }
    const start = local + 30 + localName + localExtra; range(bytes, start, compressed, central); let finish = start + compressed;
    if (flags & 8) { range(bytes, finish, 12, central); const signed = bytes.readUInt32LE(finish) === 0x08074b50; if (signed) { range(bytes, finish, 16, central); finish += 4; } if (bytes.readUInt32LE(finish) !== crc || bytes.readUInt32LE(finish + 4) !== compressed || bytes.readUInt32LE(finish + 8) !== size) throw fail(); finish += 12; }
    entries.push({ name: relativePath, directory, local, start, finish, compressed, size, crc, method }); cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) throw fail();
  let previous = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) { if (entry.local !== previous) throw fail(); previous = entry.finish; }
  if (previous !== central) throw fail();
  const files = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
  for (const entry of entries) { const pieces = entry.name.toLowerCase().split('/'); for (let n = 1; n < pieces.length; n++) if (files.has(pieces.slice(0, n).join('/'))) throw fail(); }
  const decoded = [];
  for (const entry of entries) {
    if (signal?.aborted) throw fail('DRUM_MT_CANCELLED');
    const source = bytes.subarray(entry.start, entry.start + entry.compressed); let data;
    try { if (entry.method === 0) data = Buffer.from(source); else { const result = await inflate(source, { maxOutputLength: Math.max(1, entry.size), info: true }); if (result.engine.bytesWritten !== source.length) throw fail(); data = result.buffer; } } catch { throw fail(); }
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw fail();
    if (entry.directory) continue;
    decoded.push({ path: entry.name, bytes: data });
  }
  const plugins = decoded.filter(entry => path.posix.basename(entry.path) === 'MT-PowerDrumKit.vst3');
  if (plugins.length !== 1) throw fail();
  const plugin = plugins[0], contentPath = path.posix.join(path.posix.dirname(plugin.path), 'MT-PowerDrumKit-Content.pdk');
  const content = decoded.find(entry => entry.path === contentPath);
  if (!content || !content.bytes.length) throw fail(); peX64(plugin.bytes);
  if (decoded.some(entry => entry.path.toLowerCase() === 'chartshub-mt-receipt.json')) throw fail();
  return { files: decoded, pluginRelativePath: plugin.path };
}

function createMtInstaller({ dataDirectory, fetcher = globalThis.fetch, onChange = () => {} } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || typeof fetcher !== 'function') throw fail('DRUM_MT_UNAVAILABLE');
  let disposed = false, active = null, current = { version: MT_VERSION, state: 'idle', progress: { receivedBytes: 0, totalBytes: null }, error: null };
  const status = () => structuredClone(current);
  function publish(patch) { current = { ...current, ...patch }; try { onChange(status()); } catch { /* UI disposal must not affect transaction cleanup. */ } }
  function valid(run) { if (disposed || active !== run || run.controller.signal.aborted) throw fail('DRUM_MT_CANCELLED'); }
  function wait(run, promise) {
    return new Promise((resolve, reject) => { const signal = run.controller.signal, abort = () => reject(fail(run.timedOut ? 'DRUM_MT_TIMEOUT' : 'DRUM_MT_CANCELLED')); signal.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); if (signal.aborted) abort(); });
  }
  async function noLinkedAncestors(target) {
    const chain = []; let cursor = path.resolve(target);
    for (;;) { chain.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    for (const item of chain) { const stat = await fs.lstat(item).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); if (!stat) break; if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('DRUM_MT_STORAGE'); }
  }
  async function baseDirectory() {
    await noLinkedAncestors(dataDirectory); await fs.mkdir(dataDirectory, { recursive: true }); await noLinkedAncestors(dataDirectory);
    const base = await fs.realpath(dataDirectory), same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same(path.resolve(base), path.resolve(dataDirectory))) throw fail('DRUM_MT_STORAGE'); let folder = base;
    for (const name of ['instruments', 'mt-power-drum-kit']) { folder = path.join(folder, name); await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; }); const stat = await fs.lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(folder)) !== path.resolve(folder)) throw fail('DRUM_MT_STORAGE'); }
    return folder;
  }
  async function cleanup(stage, base) {
    if (!stage) return;
    const target = path.resolve(stage), root = path.resolve(base);
    if (!target.startsWith(root + path.sep) || !/^\.stage-[a-f0-9-]{36}$/.test(path.basename(target))) throw fail('DRUM_MT_STORAGE');
    const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await fs.realpath(target)) === target) await fs.rm(target, { recursive: true, force: false });
  }
  async function performInstall(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || payload.consent !== true) throw fail('DRUM_MT_CONSENT');
    if (disposed) throw fail('DRUM_MT_UNAVAILABLE'); if (active) throw fail('DRUM_MT_BUSY');
    const run = { controller: new AbortController(), timedOut: false }, consentedAt = new Date().toISOString(); active = run;
    const timer = setTimeout(() => { run.timedOut = true; run.controller.abort(); }, 90000); let stage, base;
    publish({ state: 'downloading', progress: { receivedBytes: 0, totalBytes: null }, error: null });
    try {
      const response = await wait(run, fetcher(MT_URL, { method: 'GET', redirect: 'error', signal: run.controller.signal })); valid(run);
      if (!response || response.status !== 200 || response.redirected || response.url !== MT_URL || !response.body?.getReader) throw fail('DRUM_MT_DOWNLOAD');
      const lengthText = response.headers?.get('content-length'), total = lengthText === null || lengthText === undefined ? null : /^\d+$/.test(lengthText) ? Number(lengthText) : NaN;
      if (total !== null && (!Number.isSafeInteger(total) || total < 22 || total > MAX_ZIP_BYTES)) throw fail('DRUM_MT_DOWNLOAD');
      const reader = response.body.getReader(), download = Buffer.allocUnsafe(total ?? MAX_ZIP_BYTES); let received = 0, reads = 0, completed = false, progressAt = 0;
      try {
        for (;;) { const { done, value } = await wait(run, reader.read()); valid(run); if (done) { completed = true; break; } if (++reads > 131072 || !(value instanceof Uint8Array) || value.byteLength > download.length - received) throw fail('DRUM_MT_DOWNLOAD'); download.set(value, received); received += value.byteLength; const progress = { receivedBytes: received, totalBytes: total }; if (Date.now() - progressAt >= 100) { progressAt = Date.now(); publish({ progress }); } else current = { ...current, progress }; }
      } finally { if (!completed) void Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock?.(); }
      if (total !== null && received !== total || received < 22) throw fail('DRUM_MT_DOWNLOAD'); valid(run);
      const archive = download.subarray(0, received), archiveSha256 = sha(archive); publish({ state: 'extracting' });
      const inspected = await inspectMtArchive(archive, run.controller.signal); valid(run); base = await baseDirectory(); valid(run);
      const id = randomUUID(); stage = path.join(base, '.stage-' + id); await fs.mkdir(stage); const committed = path.join(base, MT_VERSION + '-' + id);
      const files = [];
      for (const file of inspected.files) { valid(run); const target = path.resolve(stage, ...file.path.split('/')); if (!target.startsWith(stage + path.sep)) throw fail('DRUM_MT_STORAGE'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 }); files.push({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) }); }
      const receipt = { schema: 1, version: MT_VERSION, sourceUrl: MT_URL, archiveBytes: archive.length, archiveSha256, archiveHashKind: 'computed-download', officialPublishedSha256: null, licenseUrl: MT_LICENSE_URL, consent: true, consentedAt, installedAt: new Date().toISOString(), files };
      await fs.writeFile(path.join(stage, 'chartshub-mt-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); valid(run);
      try { await fs.lstat(committed); throw fail('DRUM_MT_STORAGE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(stage, committed); stage = null; publish({ state: 'installed', progress: { receivedBytes: received, totalBytes: received }, error: null });
      return { pluginPath: path.join(committed, ...inspected.pluginRelativePath.split('/')), version: MT_VERSION, receipt };
    } catch (error) { const code = run.controller.signal.aborted ? run.timedOut ? 'DRUM_MT_TIMEOUT' : 'DRUM_MT_CANCELLED' : typeof error?.code === 'string' && /^DRUM_MT_/.test(error.code) ? error.code : current.state === 'downloading' ? 'DRUM_MT_DOWNLOAD' : 'DRUM_MT_STORAGE'; publish({ state: code === 'DRUM_MT_CANCELLED' ? 'idle' : 'error', error: code }); throw fail(code); }
    finally { clearTimeout(timer); await cleanup(stage, base).catch(() => {}); if (active === run) active = null; }
  }
  function install(payload) { const task = performInstall(payload); if (active && !active.task) active.task = task; return task; }
  function cancel() { active?.controller.abort(); }
  async function dispose() { disposed = true; const task = active?.task; cancel(); if (task) await task.catch(() => {}); }
  return { status, install, cancel, dispose };
}
module.exports = { createMtInstaller, inspectMtArchive, MT_VERSION, MT_URL, MT_LICENSE_URL, MAX_ZIP_BYTES, MAX_DECODED_BYTES, MAX_ENTRIES };
