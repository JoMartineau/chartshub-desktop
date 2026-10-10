'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { normalizeMetadata, findMatches, buildInstalledLookup, annotateInstalled } = require('./chart-matching.cjs');
const { endpointValid } = require('../download.js');

const HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const MAX_ARTWORK = 3 * 1024 * 1024, CACHE_BYTES = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const associationKey = (root, local) => `${root}:${local}`;
const failure = message => new Error(message);
const stale = () => failure('La sélection a changé. Rechargez les correspondances avant de confirmer.');
const publicFields = ['id', 'title', 'artist', 'charter', 'charterSegments', 'staffRole', 'verified', 'album', 'year', 'genre', 'duration', 'game', 'instruments', 'difficulties', 'instrumentDifficulties', 'instrumentIntensities', 'contentHash', 'viewUrl'];
function validateLinks(value) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.links)) throw Error('Invalid associations');
  const links = new Map();
  for (const item of value.links) {
    if (!object(item) || Object.keys(item).some(key => !['rootKey', 'localId', 'fingerprint', 'chartId', 'linkedAt'].includes(key)) || !HEX.test(item.rootKey) || !HEX.test(item.localId) || !HEX.test(item.fingerprint) || typeof item.chartId !== 'string' || !ID.test(item.chartId) || typeof item.linkedAt !== 'string' || item.linkedAt.length > 50 || !Number.isFinite(Date.parse(item.linkedAt))) throw Error('Invalid association');
    const key = associationKey(item.rootKey, item.localId);
    if (links.has(key)) throw Error('Duplicate association');
    links.set(key, { ...item });
  }
  return links;
}
function allowedView(record) {
  try {
    const url = new URL(record.viewUrl);
    return url.origin === 'https://chartshub.ca' && url.pathname === '/index.html' && !url.username && !url.password && !url.hash
      && url.searchParams.get('chart') === record.id && url.searchParams.get('share') === '2'
      && [...url.searchParams.keys()].length === 2;
  } catch { return false; }
}

/** Public catalogue data and explicit, root-scoped associations. No library data leaves this service. */
function createCatalogueService({ dataDirectory, client, getLibrary, onChange } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || typeof client?.load !== 'function' || typeof getLibrary !== 'function') throw failure('Configuration du catalogue invalide.');
  const filename = path.join(dataDirectory, 'matching.json');
  let links = new Map(), protectedFile = null, storageWarning = null, loaded = false, loadingDisk = null, serial = Promise.resolve();
  let active = true, generation = 0, request = null, hasCatalogue = false, records = new Map();
  let phase = 'idle', error = null, networkWarning = null, staleWarning = null, revision = 0, lastLoadedAt = null, demo = false, remoteRevision = null;
  let libraryCache = null, linkedCache = null, linkRevision = 0;
  const contexts = new Map();
  let artworkGeneration = 0, artworkBytes = 0, artworkRunning = 0;
  const artworkUrls = new Map(), artworkCache = new Map(), artworkRequests = new Map(), artworkQueue = [], artworkControllers = new Set();

  function status() { return { status: phase, error, warning: [networkWarning, staleWarning, storageWarning].filter(Boolean).join(' ') || null, revision, availableCount: records.size, lastLoadedAt, demo }; }
  function notify() { try { onChange?.(status()); } catch { console.warn('La notification du catalogue a échoué.'); } }
  function enqueue(action) { const operation = serial.then(action); serial = operation.catch(() => {}); return operation; }
  async function load() {
    if (loaded) return status();
    if (loadingDisk) return loadingDisk;
    loadingDisk = (async () => {
      try {
        const stat = await fs.stat(filename); if (!stat.isFile()) throw Error('Invalid associations file');
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (object(value) && Number.isInteger(value.version) && value.version > 1) { protectedFile = 'future'; throw Error('Future associations'); }
        links = validateLinks(value);
      } catch (problem) {
        if (problem?.code !== 'ENOENT') {
          protectedFile ||= 'corrupt';
          storageWarning = protectedFile === 'future' ? 'Les associations proviennent d’une version plus récente et restent protégées.' : 'Les associations sont illisibles. Le fichier original reste conservé jusqu’à une nouvelle association explicite.';
        }
      }
      loaded = true; notify(); return status();
    })();
    return loadingDisk;
  }
  function clearArtwork() {
    artworkGeneration++; artworkCache.clear(); artworkBytes = 0; artworkUrls.clear();
    for (const controller of artworkControllers) controller.abort();
    for (const task of artworkQueue.splice(0)) task.resolve(null);
    artworkRequests.clear();
  }
  async function start() {
    const expected = generation; await load(); if (expected === generation) active = true; return status();
  }
  async function stop() {
    active = false; generation++; request?.controller.abort(); request = null; contexts.clear(); clearArtwork();
    records = new Map(); hasCatalogue = false; remoteRevision = null; libraryCache = null; linkedCache = null;
    phase = 'idle'; error = null; networkWarning = null; staleWarning = null; demo = false; revision++;
    await serial; notify(); return status();
  }
  function library() {
    const snapshot = getLibrary();
    if (!object(snapshot) || !(snapshot.rootKey === null || HEX.test(snapshot.rootKey)) || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.items)) throw failure('La bibliothèque locale est indisponible.');
    if (!libraryCache || libraryCache.rootKey !== snapshot.rootKey || libraryCache.revision !== snapshot.revision) {
      contexts.clear(); linkedCache = null;
      const byId = new Map();
      for (const item of snapshot.items) if (typeof item?.id === 'string') byId.set(item.id, item);
      libraryCache = { ...snapshot, byId, lookup: buildInstalledLookup(snapshot.items) };
    }
    return libraryCache;
  }
  function libraryChanged() { contexts.clear(); libraryCache = null; linkedCache = null; revision++; notify(); }
  function associationIndex(current) {
    if (linkedCache?.rootKey === current.rootKey && linkedCache.libraryRevision === current.revision && linkedCache.linkRevision === linkRevision) return linkedCache.byChart;
    const byChart = new Map();
    if (current.rootKey && !demo) for (const association of links.values()) {
      if (association.rootKey !== current.rootKey || current.byId.get(association.localId)?.fingerprint !== association.fingerprint || !records.has(association.chartId)) continue;
      const ids = byChart.get(association.chartId) ?? []; ids.push(association.localId); byChart.set(association.chartId, ids);
    }
    linkedCache = { rootKey: current.rootKey, libraryRevision: current.revision, linkRevision, byChart }; return byChart;
  }
  function installed(record, current) {
    const localIds = associationIndex(current).get(record.id);
    return localIds?.length ? { status: 'linked', localIds: [...localIds].sort(), reason: 'Association manuelle avec la bibliothèque locale.' } : annotateInstalled(record, current.lookup);
  }
  function publicRecord(record, current) {
    const result = Object.fromEntries(publicFields.filter(key => record[key] !== undefined).map(key => [key, record[key] !== null && typeof record[key] === 'object' ? structuredClone(record[key]) : record[key]]));
    result.verified = demo ? null : record.verified === true ? true : record.verified === false ? false : null;
    result.artworkUrl = record.artworkUrl ? `chartshub-companion://app/catalogue-artwork/${digest(record.artworkUrl)}` : null;
    if (record.charterIconUrl) result.charterIconUrl = `chartshub-companion://app/catalogue-artwork/${digest(record.charterIconUrl)}`;
    if (demo) delete result.staffRole;
    result.downloadable = !demo && publicDownload(record.downloadEndpoint);
    result.installed = installed(record, current); return result;
  }
  function fetchCatalogue(force = false) {
    if (!active) throw failure('Le catalogue est arrêté. Rouvrez le panneau pour continuer.');
    if (!force && request) return request.promise;
    if (!force && hasCatalogue) return Promise.resolve();
    request?.controller.abort(); contexts.clear();
    const current = { generation: ++generation, controller: new AbortController(), promise: null };
    request = current; phase = 'loading'; error = null; notify();
    current.promise = (async () => {
      try {
        const result = await client.load({ signal: current.controller.signal, ...(remoteRevision ? { revision: remoteRevision } : {}) });
        if (!active || generation !== current.generation || current.controller.signal.aborted) throw stale();
        if (!object(result) || !Array.isArray(result.items) || result.items.length > 20000 || typeof result.demo !== 'boolean') throw Error('Invalid catalogue');
        const next = new Map();
        for (const item of result.items) {
          if (!object(item) || typeof item.id !== 'string' || !ID.test(item.id) || !allowedView(item)) throw Error('Invalid chart');
          if (!next.has(item.id)) next.set(item.id, { ...item });
        }
        records = next; clearArtwork();
        for (const item of records.values()) for (const url of [item.artworkUrl, item.charterIconUrl]) if (typeof url === 'string' && url) artworkUrls.set(digest(url), url);
        hasCatalogue = true; remoteRevision = typeof result.revision === 'string' ? result.revision : null; demo = result.demo;
        networkWarning = typeof result.warning === 'string' ? result.warning.slice(0, 512) : null;
        lastLoadedAt = new Date().toISOString(); phase = 'ready'; error = null; staleWarning = null; linkedCache = null; revision++; notify();
      } catch (problem) {
        if (active && generation === current.generation) {
          staleWarning = hasCatalogue ? 'Dernier catalogue chargé affiché ; son actualisation a échoué.' : null;
          phase = 'error'; error = problem?.code === 'CATALOGUE_TIMEOUT' ? 'Le catalogue met trop de temps à répondre. Réessayez.' : 'Le catalogue ChartsHub est indisponible. Réessayez.'; notify();
        }
        throw active && generation === current.generation ? failure(error) : stale();
      } finally { if (request === current) request = null; }
    })();
    return current.promise;
  }
  async function ready() { await load(); await fetchCatalogue(); }
  async function refresh() { await load(); await fetchCatalogue(true); return status(); }
  function filters(value = {}) {
    const keys = ['query', 'artist', 'charter', 'genre', 'year', 'instrument', 'difficulty', 'verified', 'installed', 'page'];
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure('Filtres du catalogue invalides.');
    const result = { query: '', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all', page: 1, ...value };
    if (keys.slice(0, 7).some(key => typeof result[key] !== 'string' || result[key].length > 200) || !['all', 'yes'].includes(result.verified) || !['all', 'linked', 'unlinked'].includes(result.installed) || !Number.isSafeInteger(result.page) || result.page < 1 || result.page > 1000000) throw failure('Filtres du catalogue invalides.');
    return result;
  }
  async function search(input = {}) {
    const selected = filters(input); await ready(); const current = library(), matching = [];
    const associations = selected.installed === 'all' ? null : associationIndex(current);
    const instruments = new Set(), difficulties = new Set();
    const contains = (value, term) => !term || normalizeMetadata(value).includes(normalizeMetadata(term));
    for (const record of records.values()) {
      for (const value of record.instruments ?? []) instruments.add(value);
      for (const value of record.difficulties ?? []) difficulties.add(value);
      if (!contains([record.title, record.artist, record.charter, record.album, record.genre, record.year].filter(Boolean).join(' '), selected.query)) continue;
      if (['artist', 'charter', 'genre'].some(key => !contains(record[key], selected[key]))) continue;
      if (selected.year && normalizeMetadata(record.year) !== normalizeMetadata(selected.year)) continue;
      if (selected.instrument && !(record.instruments ?? []).some(value => normalizeMetadata(value) === normalizeMetadata(selected.instrument))) continue;
      if (selected.difficulty && !(record.difficulties ?? []).some(value => normalizeMetadata(value) === normalizeMetadata(selected.difficulty))) continue;
      if (selected.instrument && selected.difficulty) {
        const pair = Object.entries(record.instrumentDifficulties ?? {}).find(([instrument]) => normalizeMetadata(instrument) === normalizeMetadata(selected.instrument));
        if (!pair || !Array.isArray(pair[1]) || !pair[1].some(value => normalizeMetadata(value) === normalizeMetadata(selected.difficulty))) continue;
      }
      if (selected.verified === 'yes' && (demo || record.verified !== true)) continue;
      // Installation filters concern explicit links only. Build potentially large
      // metadata-match badges only for the page returned to the renderer.
      const linked = associations?.has(record.id);
      if (selected.installed === 'linked' && !linked || selected.installed === 'unlinked' && linked) continue;
      matching.push(record);
    }
    const offset = (selected.page - 1) * 20;
    return { items: matching.slice(offset, offset + 20).map(record => publicRecord(record, current)), page: selected.page, pageSize: 20, total: matching.length, hasMore: offset + 20 < matching.length,
      facets: { instruments: [...instruments].sort(), difficulties: [...difficulties].sort() } };
  }
  async function candidates(localId) {
    if (typeof localId !== 'string' || !HEX.test(localId)) throw failure('Chanson locale invalide.');
    await ready(); const current = library(), local = current.byId.get(localId);
    if (!current.rootKey || !local || !HEX.test(local.fingerprint)) throw failure('Cette chanson locale n’est plus disponible.');
    const matched = findMatches(local, [...records.values()]);
    const association = links.get(associationKey(current.rootKey, localId));
    const linkedChartId = !demo && association?.fingerprint === local.fingerprint && records.has(association.chartId) ? association.chartId : null;
    if (linkedChartId && !matched.some(match => match.remote.id === linkedChartId)) matched.unshift({ remote: records.get(linkedChartId), kind: 'possible', reason: 'Association manuelle existante.', ambiguous: false });
    const visible = matched.slice(0, 200), contextId = randomBytes(16).toString('hex');
    if (contexts.size >= 32) contexts.delete(contexts.keys().next().value);
    contexts.set(contextId, { rootKey: current.rootKey, revision: current.revision, localId, fingerprint: local.fingerprint, generation, allowed: new Set(visible.map(match => match.remote.id)) });
    return { local: { id: local.id, title: local.title, artist: local.artist, charter: local.charter }, contextId,
      items: visible.map(match => ({ ...publicRecord(match.remote, current), matchKind: match.kind, reason: match.reason, ambiguous: match.ambiguous })), linkedChartId, total: matched.length };
  }
  function checkContext(localId, contextId, chartId) {
    if (!active || typeof contextId !== 'string' || !/^[a-f0-9]{32}$/.test(contextId)) throw stale();
    const context = contexts.get(contextId), snapshot = getLibrary(), local = snapshot.items?.find(item => item.id === localId);
    if (!context || context.localId !== localId || context.generation !== generation || context.rootKey !== snapshot.rootKey || context.revision !== snapshot.revision || local?.fingerprint !== context.fingerprint || (chartId !== undefined && (!context.allowed.has(chartId) || !records.has(chartId)))) throw stale();
    return context;
  }
  async function save(next, guard, recover) {
    if (protectedFile === 'future') throw failure('Les associations d’une version plus récente restent protégées.');
    if (protectedFile === 'corrupt' && !recover) throw failure('Créez une nouvelle association pour reconstruire ce fichier illisible.');
    const bytes = JSON.stringify({ version: 1, links: [...next.values()] });
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      guard();
      if (protectedFile === 'corrupt') await fs.copyFile(filename, filename + '.corrupt-' + Date.now() + '-' + randomUUID() + '.bak', constants.COPYFILE_EXCL);
      try { await fs.copyFile(filename, filename + '.bak'); } catch (problem) { if (problem?.code !== 'ENOENT') throw problem; }
      guard(); await fs.rename(temporary, filename);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(problem => { if (problem?.code !== 'ENOENT') console.warn('Le fichier temporaire des associations n’a pas pu être nettoyé.'); }); }
  }
  async function link({ localId, chartId, contextId } = {}) {
    await load(); if (demo) throw failure('Les charts de démonstration ne peuvent pas être associés.');
    if (typeof chartId !== 'string' || !ID.test(chartId)) throw failure('Chart de catalogue invalide.');
    checkContext(localId, contextId, chartId);
    return enqueue(async () => {
      const context = checkContext(localId, contextId, chartId);
      const next = new Map(links); next.set(associationKey(context.rootKey, localId), { rootKey: context.rootKey, localId, fingerprint: context.fingerprint, chartId, linkedAt: new Date().toISOString() });
      try { await save(next, () => checkContext(localId, contextId, chartId), true); }
      catch (problem) { if (/sélection|version plus récente/.test(problem.message)) throw problem; throw failure('Impossible d’enregistrer cette association. Le fichier précédent est conservé.'); }
      links = next; protectedFile = null; storageWarning = null; linkedCache = null; linkRevision++; revision++; notify(); return { linkedChartId: chartId };
    });
  }
  async function unlink({ localId, contextId } = {}) {
    await load(); if (demo) throw failure('Les charts de démonstration ne peuvent pas être associés.');
    checkContext(localId, contextId);
    return enqueue(async () => {
      const context = checkContext(localId, contextId), next = new Map(links), key = associationKey(context.rootKey, localId);
      if (!next.has(key)) return { linkedChartId: null };
      next.delete(key);
      try { await save(next, () => checkContext(localId, contextId), false); }
      catch (problem) { if (/sélection|version plus récente/.test(problem.message)) throw problem; throw failure('Impossible d’enregistrer la suppression de cette association.'); }
      links = next; linkedCache = null; linkRevision++; revision++; notify(); return { linkedChartId: null };
    });
  }
  async function openUrl(chartId) {
    const record = records.get(chartId);
    if (!active || !record || !allowedView(record)) throw failure('Ce chart n’est pas disponible dans le catalogue courant.');
    return record.viewUrl;
  }
  function downloadDescriptor(chartId) {
    const record = records.get(chartId);
    if (!active || demo || !record || !publicDownload(record.downloadEndpoint)) throw failure('Cette chart ne propose pas de téléchargement dans le catalogue courant.');
    return { chartId: record.id, title: record.title, artist: record.artist, charter: record.charter || '', endpoint: record.downloadEndpoint };
  }
  function pumpArtwork() {
    while (active && artworkRunning < 4 && artworkQueue.length) {
      const task = artworkQueue.shift(); artworkRunning++; const controller = new AbortController(); artworkControllers.add(controller);
      Promise.resolve().then(() => client.artwork(task.url, { signal: controller.signal })).then(result => {
        if (task.generation !== artworkGeneration || !active || artworkUrls.get(task.key) !== task.url || !result || !Buffer.isBuffer(result.bytes) || result.bytes.length > MAX_ARTWORK || !['image/png', 'image/jpeg', 'image/webp'].includes(result.contentType)) return null;
        const entry = { bytes: Buffer.from(result.bytes), contentType: result.contentType };
        while (artworkBytes + entry.bytes.length > CACHE_BYTES && artworkCache.size) { const oldest = artworkCache.keys().next().value; artworkBytes -= artworkCache.get(oldest).bytes.length; artworkCache.delete(oldest); }
        artworkCache.set(task.key, entry); artworkBytes += entry.bytes.length; return { ...entry, bytes: Buffer.from(entry.bytes) };
      }).catch(() => null).then(task.resolve).finally(() => {
        artworkRunning--; artworkControllers.delete(controller);
        if (artworkRequests.get(task.key) === task.promise) artworkRequests.delete(task.key);
        pumpArtwork();
      });
    }
  }
  async function artwork(key) {
    if (!active || typeof key !== 'string' || !HEX.test(key) || !artworkUrls.has(key) || typeof client.artwork !== 'function') return null;
    const cached = artworkCache.get(key);
    if (cached) { artworkCache.delete(key); artworkCache.set(key, cached); return { ...cached, bytes: Buffer.from(cached.bytes) }; }
    if (artworkRequests.has(key)) return artworkRequests.get(key);
    if (artworkQueue.length >= 256) return null;
    const task = { key, url: artworkUrls.get(key), generation: artworkGeneration, resolve: null, promise: null };
    task.promise = new Promise(resolve => { task.resolve = resolve; }); artworkRequests.set(key, task.promise); artworkQueue.push(task); pumpArtwork(); return task.promise;
  }
  return { load, start, stop, status, search, refresh, candidates, link, unlink, openUrl, downloadDescriptor, artwork, libraryChanged };
}
function publicDownload(endpoint) { return typeof endpoint === 'string' && endpoint.startsWith('/api/charts/') && endpointValid(endpoint); }
module.exports = { createCatalogueService };
