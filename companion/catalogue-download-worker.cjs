'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createDownloadWorker, rootContext, readJsonFile, writeNew, safeRemoveTree, statOrNull, identity } = require('./download-worker.cjs');
const { downloadEnchor, normalizeEnchorRequest } = require('../enchor-download');
const { safePart, songFolderName } = require('../download');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXTERNAL = /^enchor:[a-f0-9]{32}$/;
const OWNER = 'ChartsHub Companion ChorusEncore download v1';
const INSTALLING = '.chartshub-companion-installing';
const invalid = () => Object.assign(Error('Le dossier de ce téléchargement ChorusEncore a changé.'), { code: 'DOWNLOAD_PATH' });

function createCatalogueDownloadWorker({ fetcher = globalThis.fetch, nativeWorker = createDownloadWorker({ fetcher }), downloadExternal = downloadEnchor, now = Date.now } = {}) {
  const running = new Set(); let retryUntil = 0, suspended = false;
  async function stage(context, id, endpoint, create) {
    if (!UUID.test(id) || !EXTERNAL.test(endpoint)) throw invalid();
    // The library's exact UUID-stage exclusion already covers this namespace.
    // The owner discriminator prevents native and external workers from ever
    // accepting or deleting each other's receipts, even with a forged UUID.
    const directory = path.join(context.root, '.chartshub-companion-' + id), ownerPath = path.join(directory, 'owner.json');
    let info = await statOrNull(directory);
    if (!info) {
      if (!create) return null;
      await context.guard(); await fs.mkdir(directory, { mode: 0o700 });
      await writeNew(context, ownerPath, JSON.stringify({ owner: OWNER, version: 1, id, endpoint, root: context.root, rootIdentity: context.rootIdentity }));
      info = await context.checked(directory, { directory: true });
    }
    await context.checked(directory, { directory: true });
    const stageIdentity = identity(info), owner = await readJsonFile(context, ownerPath, 4096);
    if (owner.owner !== OWNER || owner.version !== 1 || owner.id !== id || owner.endpoint !== endpoint || owner.root !== context.root || owner.rootIdentity !== context.rootIdentity) throw invalid();
    const guard = async () => { if (identity(await context.checked(directory, { directory: true })) !== stageIdentity) throw invalid(); };
    const receiptPath = path.join(directory, 'receipt.json');
    let receipt = null;
    if (await statOrNull(receiptPath)) {
      receipt = await readJsonFile(context, receiptPath, 4096);
      if (receipt.owner !== OWNER || receipt.id !== id || receipt.endpoint !== endpoint || !safePart(receipt.folderName) || receipt.folderName.startsWith('.') || typeof receipt.folderIdentity !== 'string' || !Number.isSafeInteger(receipt.files) || receipt.files < 1 || !Number.isSafeInteger(receipt.totalBytes) || receipt.totalBytes < 0) throw invalid();
    }
    return { directory, guard, receiptPath, receipt };
  }
  async function removePending(context, stored) {
    if (!stored.receipt) return;
    const destination = path.join(context.root, stored.receipt.folderName), info = await statOrNull(destination);
    if (!info) return;
    if (identity(await context.checked(destination, { directory: true })) !== stored.receipt.folderIdentity) throw invalid();
    const marker = path.join(destination, INSTALLING);
    if (!await statOrNull(marker)) return; // A completed publication is never deleted.
    const owner = await readJsonFile(context, marker, 4096);
    if (owner.owner !== OWNER || owner.id !== stored.receipt.id || owner.endpoint !== stored.receipt.endpoint) throw invalid();
    await safeRemoveTree(context, destination);
  }
  async function run(options = {}) {
    if (!EXTERNAL.test(options.endpoint || '')) return nativeWorker.run(options);
    if (suspended) throw Object.assign(Error('ChorusEncore refuse les téléchargements de cette session.'), { code: 'ENCHOR_DOWNLOAD_ACCESS_DENIED' });
    if (retryUntil > now()) throw Object.assign(Error('ChorusEncore limite temporairement les téléchargements.'), { code: 'ENCHOR_DOWNLOAD_RATE_LIMITED', retryAfterSeconds: Math.ceil((retryUntil - now()) / 1000) });
    const { id, endpoint, rootPath, signal, onProgress = () => {} } = options;
    const lock = String(rootPath) + ':' + id;
    if (running.has(lock)) throw Object.assign(Error('Ce téléchargement est déjà en cours.'), { code: 'DOWNLOAD_BUSY' });
    running.add(lock); let context, stored;
    try {
      signal?.throwIfAborted(); context = await rootContext(rootPath); stored = await stage(context, id, endpoint, true);
      if (stored.receipt) {
        const destination = path.join(context.root, stored.receipt.folderName), info = await statOrNull(destination);
        if (info) {
          if (identity(await context.checked(destination, { directory: true })) !== stored.receipt.folderIdentity) throw invalid();
          if (!await statOrNull(path.join(destination, INSTALLING))) return { ...stored.receipt, destination };
          await removePending(context, stored);
        }
        await context.checked(stored.receiptPath); await fs.unlink(stored.receiptPath); stored.receipt = null;
      }
      // The existing SNG validator imports only into this UUID's owned stage.
      // Publication uses the same guarded root and marker as native manifests.
      await stored.guard();
      const request = normalizeEnchorRequest({ md5: endpoint.slice(7), title: options.title || '', artist: options.artist || '' });
      const result = await downloadExternal({ request, directory: stored.directory, format: 'folder', includeVideo: true, fetcher, signal, guard: stored.guard, progress: value => onProgress({ currentFile: typeof value?.message === 'string' ? value.message : null }) });
      signal?.throwIfAborted(); await stored.guard();
      if (typeof result?.destination !== 'string' || path.dirname(result.destination) !== stored.directory || !safePart(path.basename(result.destination))) throw invalid();
      await context.checked(result.destination, { directory: true });
      const members = []; let totalBytes = 0;
      async function collect(directory, parts = []) {
        await stored.guard(); await context.checked(directory, { directory: true });
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!safePart(entry.name) || entry.name === INSTALLING) throw invalid();
          const target = path.join(directory, entry.name), info = await fs.lstat(target);
          if (info.isSymbolicLink()) throw invalid();
          if (info.isDirectory()) await collect(target, [...parts, entry.name]);
          // SNG permits 1000 original members. Folder import can reconstruct
          // one additional song.ini from the validated container metadata.
          else { await context.checked(target); if (members.length >= 1001 || !Number.isSafeInteger(info.size) || !Number.isSafeInteger(totalBytes += info.size)) throw invalid(); members.push({ source: target, parts: [...parts, entry.name] }); }
        }
      }
      await collect(result.destination); if (!members.length) throw invalid();
      const base = songFolderName(request); let folderName, destination;
      for (let suffix = 1; suffix <= 10000; suffix++) {
        signal?.throwIfAborted(); await context.guard(); folderName = base + (suffix === 1 ? '' : ` (${suffix})`); if (!safePart(folderName)) throw invalid(); destination = path.join(context.root, folderName);
        try { await fs.mkdir(destination, { mode: 0o700 }); break; } catch (problem) { if (problem.code !== 'EEXIST' || suffix === 10000) throw problem; destination = null; }
      }
      await writeNew(context, path.join(destination, INSTALLING), JSON.stringify({ owner: OWNER, id, endpoint }));
      stored.receipt = { owner: OWNER, id, endpoint, folderName, folderIdentity: identity(await context.checked(destination, { directory: true })), files: members.length, totalBytes };
      await writeNew(context, stored.receiptPath, JSON.stringify(stored.receipt));
      for (const member of members) {
        signal?.throwIfAborted(); await stored.guard();
        if (identity(await context.checked(destination, { directory: true })) !== stored.receipt.folderIdentity) throw invalid();
        const target = path.join(destination, ...member.parts); await context.mkdir(path.dirname(target)); await context.checked(member.source); await context.checked(target, { missing: true }); await fs.copyFile(member.source, target, constants.COPYFILE_EXCL); await context.checked(target);
      }
      signal?.throwIfAborted(); await context.checked(path.join(destination, INSTALLING)); await fs.unlink(path.join(destination, INSTALLING));
      // Once the marker is removed, publication wins over a late cancellation.
      try { await safeRemoveTree(context, result.destination); } catch {}
      onProgress({ receivedBytes: totalBytes, totalBytes, completedFiles: members.length, totalFiles: members.length, currentFile: null });
      return { destination, folderName, files: members.length, totalBytes };
    } catch (problem) {
      if (context && stored?.receipt) { try { await removePending(context, stored); } catch {} }
      if (problem?.name === 'AbortError' || signal?.aborted) throw Object.assign(Error('Téléchargement interrompu.'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (problem?.code === 'ENCHOR_DOWNLOAD_ACCESS_DENIED') suspended = true;
      if (problem?.code === 'ENCHOR_DOWNLOAD_RATE_LIMITED') retryUntil = Math.max(retryUntil, now() + Math.min(Math.max(30, problem.retryAfterSeconds || 0) * 1000, Number.MAX_SAFE_INTEGER - now()));
      if (typeof problem?.code === 'string' && /^(DOWNLOAD_|ENCHOR_DOWNLOAD_)/.test(problem.code)) throw problem;
      throw Object.assign(Error('Le téléchargement ChorusEncore a échoué.'), { code: 'DOWNLOAD_INVALID' });
    } finally { running.delete(lock); }
  }
  async function discard(options = {}) {
    if (!EXTERNAL.test(options.endpoint || '')) return nativeWorker.discard(options);
    const lock = String(options.rootPath) + ':' + options.id;
    if (running.has(lock)) throw Object.assign(Error('Ce téléchargement est encore en cours.'), { code: 'DOWNLOAD_BUSY' });
    if (!await statOrNull(options.rootPath)) return;
    const context = await rootContext(options.rootPath), stored = await stage(context, options.id, options.endpoint, false);
    if (stored) { await stored.guard(); await removePending(context, stored); await safeRemoveTree(context, stored.directory); }
  }
  return { run, discard, resolveCompleted: options => nativeWorker.resolveCompleted(options) };
}
module.exports = { createCatalogueDownloadWorker };
