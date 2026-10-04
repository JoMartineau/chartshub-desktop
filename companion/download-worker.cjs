'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const crypto = require('node:crypto');
const { ORIGIN, endpointValid, safePart, validateManifest, validateDestination, songFolderName } = require('../download.js');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PUBLIC_ENDPOINT = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/;
const OWNER = 'ChartsHub Companion download v1';
const INSTALLING = '.chartshub-companion-installing';
const active = new Set();
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const identity = stat => `${stat.dev}:${stat.ino}`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fileKey = file => digest(JSON.stringify(file.parts));
const signature = file => digest(JSON.stringify([file.parts, file.size, file.url, file.sha256 ?? null]));
function failure(code) {
  const messages = {
    DOWNLOAD_INVALID: 'Le manifeste de téléchargement ChartsHub est invalide.',
    DOWNLOAD_TIMEOUT: 'Le téléchargement ne reçoit plus de données. Réessayez.',
    DOWNLOAD_NETWORK: 'La connexion à ChartsHub a échoué.',
    DOWNLOAD_HTTP: 'ChartsHub ne peut pas fournir ces fichiers pour le moment.',
    DOWNLOAD_INTEGRITY: 'La taille ou l’empreinte du fichier téléchargé ne correspond pas au manifeste.',
    DOWNLOAD_PATH: 'Le dossier de téléchargement a changé ou contient un lien non autorisé.',
    DOWNLOAD_BUSY: 'Ce téléchargement est déjà en cours.',
    DOWNLOAD_IO: 'Impossible d’enregistrer les fichiers. Vérifiez le dossier et l’espace disponible.'
  };
  const error = Error(messages[code] || messages.DOWNLOAD_IO); error.code = code; return error;
}
function cancelled() { const error = Error('Téléchargement interrompu.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error; }
function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }
function validEndpoint(value) { return endpointValid(value) && PUBLIC_ENDPOINT.test(value); }
async function statOrNull(target) { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function rootContext(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw failure('DOWNLOAD_PATH');
  const root = path.resolve(rootPath), stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(root), root)) throw failure('DOWNLOAD_PATH');
  const rootIdentity = identity(stat);
  async function guard() {
    const current = await fs.lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== rootIdentity || !samePath(await fs.realpath(root), root)) throw failure('DOWNLOAD_PATH');
  }
  async function checked(target, { missing = false, directory = false } = {}) {
    await guard();
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw failure('DOWNLOAD_PATH');
    let current = root;
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); const stat = await statOrNull(current);
      if (!stat && missing && index === parts.length - 1) return null;
      if (!stat || stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw failure('DOWNLOAD_PATH');
      if (index < parts.length - 1 || directory) { if (!stat.isDirectory()) throw failure('DOWNLOAD_PATH'); }
      else if (!stat.isFile()) throw failure('DOWNLOAD_PATH');
      if (index === parts.length - 1) return stat;
    }
  }
  async function mkdir(target) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure('DOWNLOAD_PATH');
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part); await guard();
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await checked(current, { directory: true });
    }
  }
  return { root, rootIdentity, guard, checked, mkdir };
}

async function readJsonFile(context, target, limit = 2_000_000) {
  const stat = await context.checked(target);
  if (stat.size > limit) throw failure('DOWNLOAD_PATH');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (identity(await handle.stat()) !== identity(stat)) throw failure('DOWNLOAD_PATH');
    const bytes = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw failure('DOWNLOAD_PATH');
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { throw failure('DOWNLOAD_PATH'); }
  } finally { await handle.close(); }
}

async function writeNew(context, target, contents) {
  if (await context.checked(target, { missing: true })) throw failure('DOWNLOAD_PATH');
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}

async function safeRemoveTree(context, target) {
  await context.checked(target, { directory: true });
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name), stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw failure('DOWNLOAD_PATH');
    if (stat.isDirectory()) await safeRemoveTree(context, child);
    else { await context.checked(child); await fs.unlink(child); }
  }
  await context.checked(target, { directory: true }); await fs.rmdir(target);
}

async function hashFile(context, target, size, signal) {
  const stat = await context.checked(target);
  if (stat.size !== size) return null;
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (identity(await handle.stat()) !== identity(stat)) throw failure('DOWNLOAD_PATH');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(128 * 1024); let total = 0;
    for (;;) {
      checkAbort(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break; total += bytesRead; if (total > size) return null; hash.update(buffer.subarray(0, bytesRead));
    }
    const finalStat = await context.checked(target);
    if (identity(finalStat) !== identity(stat) || identity(await handle.stat()) !== identity(stat)) throw failure('DOWNLOAD_PATH');
    return total === size ? hash.digest('hex') : null;
  } finally { await handle.close(); }
}

function createDownloadWorker({ fetcher = globalThis.fetch, idleTimeoutMs = 60000, headerTimeoutMs = 1800000, manifestTimeoutMs = 30000 } = {}) {
  if (typeof fetcher !== 'function' || ![idleTimeoutMs, headerTimeoutMs, manifestTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 1800000)) throw failure('DOWNLOAD_INVALID');

  async function request(endpoint, { signal, size, consume }) {
    checkAbort(signal);
    const controller = new AbortController(); let timeout = false, timer, reader, response, closed = false;
    let rejectAbort;
    const interrupted = new Promise((_resolve, reject) => { rejectAbort = () => reject(timeout ? failure('DOWNLOAD_TIMEOUT') : cancelled()); });
    interrupted.catch(() => {});
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const relay = () => controller.abort(); signal?.addEventListener('abort', relay, { once: true });
    const touch = delay => { clearTimeout(timer); timer = setTimeout(() => { timeout = true; controller.abort(); }, delay); };
    const wait = promise => Promise.race([promise, interrupted]);
    try {
      touch(size === undefined ? manifestTimeoutMs : headerTimeoutMs);
      const url = ORIGIN + endpoint;
      const pending = Promise.resolve().then(() => fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Accept: size === undefined ? 'application/json' : 'application/octet-stream' }, signal: controller.signal }));
      void pending.then(value => { if (closed && value?.body) void value.body.cancel().catch(() => {}); }, () => {});
      try { response = await wait(pending); } catch (error) { if (controller.signal.aborted) throw timeout ? failure('DOWNLOAD_TIMEOUT') : cancelled(); throw failure('DOWNLOAD_NETWORK'); }
      if (!response || response.status !== 200 || response.redirected || (response.url && response.url !== url)) throw failure('DOWNLOAD_HTTP');
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || (size === undefined ? Number(contentLength) > 2_000_000 : Number(contentLength) !== size))) throw failure(size === undefined ? 'DOWNLOAD_INVALID' : 'DOWNLOAD_INTEGRITY');
      if (size === undefined && (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('DOWNLOAD_INVALID');
      if (!response.body || typeof response.body.getReader !== 'function') throw failure('DOWNLOAD_HTTP');
      reader = response.body.getReader(); touch(idleTimeoutMs);
      let bytes = 0; const chunks = [];
      for (;;) {
        let result;
        try { result = await wait(reader.read()); }
        catch (error) { if (controller.signal.aborted) throw timeout ? failure('DOWNLOAD_TIMEOUT') : cancelled(); throw failure('DOWNLOAD_NETWORK'); }
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw failure('DOWNLOAD_INVALID');
        bytes += result.value.byteLength;
        if (bytes > (size ?? 2_000_000)) throw failure(size === undefined ? 'DOWNLOAD_INVALID' : 'DOWNLOAD_INTEGRITY');
        touch(idleTimeoutMs);
        if (consume) await consume(result.value, bytes); else chunks.push(Buffer.from(result.value));
        if (controller.signal.aborted) throw timeout ? failure('DOWNLOAD_TIMEOUT') : cancelled();
      }
      if (size !== undefined) { if (bytes !== size) throw failure('DOWNLOAD_INTEGRITY'); return; }
      try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw failure('DOWNLOAD_INVALID'); }
    } finally {
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', relay); controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      if (reader) void reader.cancel().catch(() => {}); else if (response?.body) void response.body.cancel().catch(() => {});
    }
  }

  async function loadStage(context, id, endpoint, create) {
    const staging = path.join(context.root, '.chartshub-companion-' + id);
    let stat = await statOrNull(staging);
    if (!stat) {
      if (!create) return null;
      await context.guard(); await fs.mkdir(staging, { mode: 0o700 });
      await writeNew(context, path.join(staging, 'owner.json'), JSON.stringify({ owner: OWNER, version: 1, id, endpoint, root: context.root, rootIdentity: context.rootIdentity }));
      stat = await context.checked(staging, { directory: true });
    }
    await context.checked(staging, { directory: true });
    const stageIdentity = identity(stat), owner = await readJsonFile(context, path.join(staging, 'owner.json'), 4096);
    if (owner?.owner !== OWNER || owner.version !== 1 || owner.id !== id || !validEndpoint(owner.endpoint) || (endpoint && owner.endpoint !== endpoint) || typeof owner.root !== 'string' || !samePath(owner.root, context.root) || owner.rootIdentity !== context.rootIdentity) throw failure('DOWNLOAD_PATH');
    async function guard() {
      if (identity(await context.checked(staging, { directory: true })) !== stageIdentity) throw failure('DOWNLOAD_PATH');
    }
    const statePath = path.join(staging, 'checkpoint.json');
    let state = { version: 1, completed: {} };
    if (await statOrNull(statePath)) state = await readJsonFile(context, statePath);
    if (state?.version !== 1 || !state.completed || typeof state.completed !== 'object' || Array.isArray(state.completed) || Object.keys(state.completed).length > 1000) throw failure('DOWNLOAD_PATH');
    for (const [key, item] of Object.entries(state.completed)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !item || !/^[a-f0-9]{64}$/.test(item.signature) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 2_000_000_000) throw failure('DOWNLOAD_PATH');
    }
    if (state.pending !== undefined && (!safePart(state.pending) || state.pending.startsWith('.chartshub-companion-'))) throw failure('DOWNLOAD_PATH');
    async function save() {
      await guard(); const temporary = path.join(staging, 'checkpoint-' + crypto.randomUUID() + '.tmp');
      await writeNew(context, temporary, JSON.stringify(state));
      try { await guard(); await context.checked(statePath, { missing: true }); await fs.rename(temporary, statePath); }
      finally { if (await statOrNull(temporary)) { await context.checked(temporary); await fs.unlink(temporary); } }
    }
    const files = path.join(staging, 'files'); await context.mkdir(files);
    return { staging, files, state, guard, save, owner };
  }

  async function removePending(context, stage, id) {
    if (!stage.state.pending) return;
    const destination = path.join(context.root, stage.state.pending), marker = path.join(destination, INSTALLING);
    if (!await statOrNull(destination)) { delete stage.state.pending; await stage.save(); return; }
    await context.checked(destination, { directory: true });
    // Marker absence means publication already completed; never remove that directory.
    if (!await statOrNull(marker)) return;
    const owner = await readJsonFile(context, marker, 4096);
    if (owner?.owner !== OWNER || owner.id !== id) throw failure('DOWNLOAD_PATH');
    await safeRemoveTree(context, destination); delete stage.state.pending; await stage.save();
  }

  async function run({ id, endpoint, rootPath, signal, onProgress = () => {} } = {}) {
    if (!UUID.test(id) || !validEndpoint(endpoint)) throw failure('DOWNLOAD_INVALID');
    const lock = path.resolve(String(rootPath)) + ':' + id;
    if (active.has(lock)) throw failure('DOWNLOAD_BUSY'); active.add(lock);
    let stage, context, interruptedPath;
    try {
      checkAbort(signal); context = await rootContext(rootPath);
      const raw = await request(endpoint, { signal });
      let totalBytes;
      try { totalBytes = validateManifest(raw, endpoint); } catch { throw failure('DOWNLOAD_INVALID'); }
      const manifest = { title: typeof raw.title === 'string' ? raw.title.slice(0, 2048) : '', artist: typeof raw.artist === 'string' ? raw.artist.slice(0, 2048) : '',
        files: raw.files.map(file => ({ parts: [...file.parts], size: file.size, url: file.url, ...(file.sha256 ? { sha256: file.sha256 } : {}) })) };
      if (manifest.files.some(file => file.parts.some(part => part.toLowerCase() === INSTALLING))) throw failure('DOWNLOAD_INVALID');
      try { validateDestination(context.root, songFolderName(manifest), manifest.files); } catch { throw failure('DOWNLOAD_PATH'); }
      checkAbort(signal); stage = await loadStage(context, id, endpoint, true);
      await removePending(context, stage, id);
      if (stage.state.pending && !await statOrNull(path.join(context.root, stage.state.pending, INSTALLING))) {
        // Crash between publication and checkpoint cleanup: report the completed installation.
        const destination = await resolveCompleted({ rootPath: context.root, destination: path.join(context.root, stage.state.pending) });
        if (!destination) throw failure('DOWNLOAD_PATH');
        if (Object.keys(stage.state.completed).length !== manifest.files.length) throw failure('DOWNLOAD_INTEGRITY');
        for (const file of manifest.files) {
          const saved = stage.state.completed[fileKey(file)];
          if (!saved || saved.signature !== signature(file) || await hashFile(context, path.join(destination, ...file.parts), file.size, signal) !== saved.sha256) throw failure('DOWNLOAD_INTEGRITY');
        }
        const result = { destination, folderName: stage.state.pending, files: manifest.files.length, totalBytes };
        return result;
      }
      let receivedBytes = 0, completedFiles = 0;
      const progress = (currentFile = null, extra = 0) => { try { onProgress({ receivedBytes: receivedBytes + extra, totalBytes, completedFiles, totalFiles: manifest.files.length, currentFile }); } catch {} };
      progress();
      const needed = new Set(manifest.files.map(fileKey));
      for (const key of Object.keys(stage.state.completed)) if (!needed.has(key)) {
        const target = path.join(stage.files, key + '.blob');
        if (await statOrNull(target)) { await stage.guard(); await context.checked(target); await fs.unlink(target); }
        delete stage.state.completed[key];
      }
      await stage.save();
      for (const file of manifest.files) {
        checkAbort(signal); await stage.guard();
        const key = fileKey(file), target = path.join(stage.files, key + '.blob'), saved = stage.state.completed[key], name = file.parts.join('/');
        let reusable = false;
        if (saved && saved.signature === signature(file) && saved.size === file.size && (!file.sha256 || saved.sha256 === file.sha256) && await statOrNull(target)) reusable = await hashFile(context, target, file.size, signal) === saved.sha256;
        if (reusable) { receivedBytes += file.size; completedFiles++; progress(name); continue; }
        if (await statOrNull(target)) { await context.checked(target); await fs.unlink(target); }
        delete stage.state.completed[key]; await stage.save();
        interruptedPath = path.join(stage.staging, 'active.part');
        if (await statOrNull(interruptedPath)) { await context.checked(interruptedPath); await fs.unlink(interruptedPath); }
        await stage.guard(); await context.checked(interruptedPath, { missing: true });
        const handle = await fs.open(interruptedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600), hash = crypto.createHash('sha256');
        progress(name);
        try {
          await request(file.url, { signal, size: file.size, consume: async (chunk, bytes) => {
            await stage.guard(); hash.update(chunk); let offset = 0;
            while (offset < chunk.byteLength) { const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset); if (!bytesWritten) throw failure('DOWNLOAD_IO'); offset += bytesWritten; }
            progress(name, bytes);
          } });
          await handle.sync();
        } finally { await handle.close(); }
        const sha256 = hash.digest('hex');
        if (file.sha256 && sha256 !== file.sha256) throw failure('DOWNLOAD_INTEGRITY');
        checkAbort(signal); await stage.guard(); await context.checked(interruptedPath); await context.checked(target, { missing: true });
        await fs.rename(interruptedPath, target); interruptedPath = null;
        stage.state.completed[key] = { signature: signature(file), size: file.size, sha256 }; await stage.save();
        receivedBytes += file.size; completedFiles++; progress(name);
      }
      // All file verification and cancellation checks finish before publication begins.
      for (const file of manifest.files) {
        const saved = stage.state.completed[fileKey(file)];
        if (await hashFile(context, path.join(stage.files, fileKey(file) + '.blob'), file.size, signal) !== saved.sha256) throw failure('DOWNLOAD_INTEGRITY');
      }
      checkAbort(signal); await stage.guard();
      const base = songFolderName(manifest); let destination, folderName;
      for (let suffix = 1; suffix <= 10000; suffix++) {
        folderName = base + (suffix === 1 ? '' : ` (${suffix})`);
        try { validateDestination(context.root, folderName, manifest.files); } catch { throw failure('DOWNLOAD_PATH'); }
        destination = path.join(context.root, folderName); await context.guard();
        try { await fs.mkdir(destination, { mode: 0o700 }); break; } catch (error) { if (error.code !== 'EEXIST' || suffix === 10000) throw error; destination = null; }
      }
      let published = false;
      try {
        await writeNew(context, path.join(destination, INSTALLING), JSON.stringify({ owner: OWNER, id }));
        stage.state.pending = folderName; await stage.save();
        // The library ignores this marked directory until every complete file is in place.
        // Linking/copying is exclusive, so even unexpected existing files are never replaced.
        const files = [...manifest.files].sort((a, b) => Number(/\.(ini|chart|mid|midi)$/i.test(a.parts.at(-1))) - Number(/\.(ini|chart|mid|midi)$/i.test(b.parts.at(-1))));
        for (const file of files) {
          const source = path.join(stage.files, fileKey(file) + '.blob'), target = path.join(destination, ...file.parts);
          await stage.guard(); await context.checked(source); await context.mkdir(path.dirname(target)); await context.checked(target, { missing: true });
          try { await fs.link(source, target); }
          catch (error) { if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error; await fs.copyFile(source, target, constants.COPYFILE_EXCL); }
          await context.checked(target);
        }
        await context.checked(path.join(destination, INSTALLING)); await fs.unlink(path.join(destination, INSTALLING)); published = true;
        progress();
        // A pause arriving after publication must be reported as completed, never cancelled.
        // Keep the small receipt until the queue explicitly discards it. A process crash
        // before queue persistence can then recover this folder without a second install.
        try { await safeRemoveTree(context, stage.files); } catch { /* A valid checkpoint permits recovery; completed data remains untouched. */ }
        return { destination, folderName, files: manifest.files.length, totalBytes };
      } catch (error) {
        if (!published) {
          try { await removePending(context, stage, id); }
          catch { /* Keep the marker when rollback cannot be proved safe; the scanner skips it. */ }
        }
        throw error;
      }
    } catch (error) {
      if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError') throw cancelled();
      if (/^DOWNLOAD_(?:INVALID|TIMEOUT|NETWORK|HTTP|INTEGRITY|PATH|BUSY|IO)$/.test(error?.code)) throw failure(error.code);
      throw failure('DOWNLOAD_IO');
    } finally {
      if (interruptedPath && context && stage) {
        try { await stage.guard(); if (await statOrNull(interruptedPath)) { await context.checked(interruptedPath); await fs.unlink(interruptedPath); } } catch {}
      }
      active.delete(lock);
    }
  }

  async function discard({ id, rootPath } = {}) {
    if (!UUID.test(id)) throw failure('DOWNLOAD_INVALID');
    const lock = path.resolve(String(rootPath)) + ':' + id;
    if (active.has(lock)) throw failure('DOWNLOAD_BUSY'); active.add(lock);
    try {
      if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw failure('DOWNLOAD_PATH');
      if (!await statOrNull(rootPath)) return;
      const context = await rootContext(rootPath), stage = await loadStage(context, id, undefined, false);
      if (stage) { await stage.guard(); await removePending(context, stage, id); await safeRemoveTree(context, stage.staging); }
    } catch (error) { if (error?.code?.startsWith('DOWNLOAD_')) throw error; throw failure('DOWNLOAD_IO'); }
    finally { active.delete(lock); }
  }

  async function resolveCompleted({ rootPath, destination } = {}) {
    try {
      const context = await rootContext(rootPath);
      if (typeof destination !== 'string' || !path.isAbsolute(destination) || !samePath(path.dirname(destination), context.root) || path.basename(destination).startsWith('.chartshub-companion-')) return null;
      await context.checked(destination, { directory: true });
      if (await statOrNull(path.join(destination, INSTALLING))) return null;
      return await fs.realpath(destination);
    } catch { return null; }
  }

  return { run, discard, resolveCompleted };
}

module.exports = { createDownloadWorker };
