'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 64 * 1024, CONFIG_BYTES = 8192;
const CAPABILITIES = Object.freeze({ title: true, artist: true, charter: true, instrument: false, difficulty: false, exactGameplay: false });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
const samePath = (a, b) => path.relative(a, b) === '';
const safe = message => Object.assign(new Error(message), { code: 'CLONEHERO_SAFE' });
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const cloneSong = song => song === null ? null : { ...song,
  ...(Array.isArray(song.charterSegments) ? { charterSegments: song.charterSegments.map(segment => segment && typeof segment === 'object' ? { ...segment } : segment) } : {}) };
const idle = () => ({ state: 'idle', isChartActive: false });
function normalize(value) {
  const cleaned = value.replace(/<\/?(?:b|i|u|s|color|size|font|alpha)(?:=[^<>]*|\s+[^<>]*)?>/gi, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
  return /^(?:undefined|null|n\/?a)$/i.test(cleaned) ? '' : cleaned;
}

/** Bounded regular-file reads, including a second identity/size check after reading. */
async function readFile(filename, limit = MAX_BYTES) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw Object.assign(Error('Invalid source file'), { code: 'SOURCE_INVALID' });
  const canonical = await fs.realpath(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || signature(opened) !== signature(before)) throw Object.assign(Error('Source changed'), { code: 'SOURCE_UNSTABLE' });
    const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat(), final = await fs.lstat(filename);
    if (offset > limit) throw Object.assign(Error('Source too large'), { code: 'SOURCE_INVALID' });
    if (signature(after) !== signature(before) || signature(final) !== signature(before) || final.isSymbolicLink() || !samePath(canonical, await fs.realpath(filename))) throw Object.assign(Error('Source changed'), { code: 'SOURCE_UNSTABLE' });
    const content = bytes.subarray(0, offset);
    const value = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
    if (value.includes('\0')) throw Object.assign(Error('Invalid source encoding'), { code: 'SOURCE_INVALID' });
    return { value, canonical, mtimeMs: after.mtimeMs, signature: signature(after) + ':' + createHash('sha256').update(content).digest('hex') };
  } finally { await handle.close(); }
}
async function exportSettings(filename) {
  let source;
  try { source = await readFile(path.join(path.dirname(filename), 'settings.ini')); }
  catch (problem) {
    if (problem?.code === 'ENOENT') return { valid: true, signature: 'no-settings' };
    return { valid: false, state: 'error', message: 'Impossible de vérifier les réglages d’export de Clone Hero.' };
  }
  const fields = new Map(); let section = '';
  for (const line of source.value.replace(/\r\n?/g, '\n').split('\n')) {
    const value = line.trim(), header = /^\[([^\]]+)\]\s*$/.exec(value);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    if (!value || /^[;#]/.test(value)) continue;
    const match = /^([a-z_]+)\s*=\s*(.*)$/i.exec(value);
    if (!match || !['song_export', 'custom_song_export'].includes(match[1].toLowerCase())) continue;
    // These are Clone Hero's streamer settings. Reading matching keys outside
    // that section would silently accept an unrelated/custom INI layout.
    if (section !== 'streamer') continue;
    const key = match[1].toLowerCase();
    if (fields.has(key)) return { valid: false, state: 'unsupported', message: 'Les réglages d’export sont ambigus. Utilisez le format natif à trois lignes.' };
    fields.set(key, match[2].trim());
  }
  if (fields.get('song_export') === '0') return { valid: false, state: 'disabled', message: 'Activez « Export Current Song » dans les réglages de Clone Hero.' };
  if (fields.get('song_export') !== '1') return { valid: false, state: 'unsupported', message: 'L’activation de l’export natif ne peut pas être confirmée dans settings.ini.' };
  const format = fields.get('custom_song_export');
  if (format !== undefined && format !== '%s%n%a%n%c') return { valid: false, state: 'unsupported', message: 'Format d’export personnalisé non pris en charge. Utilisez %s%n%a%n%c dans Clone Hero.' };
  return { valid: true, signature: source.signature };
}
async function observation(filename, parseColoredText) {
  if (!filename) return { state: 'missing', message: 'Sélectionnez le fichier currentsong.txt créé par Clone Hero.', signature: null };
  let source;
  try { source = await readFile(filename); }
  catch (problem) {
    if (['ENOENT', 'ENOTDIR'].includes(problem?.code)) return { state: 'missing', message: 'Le fichier d’export est absent. Lancez un chart avec l’export activé.', signature: null };
    if (problem?.code === 'SOURCE_UNSTABLE') return { state: 'waiting', message: 'Le fichier d’export est en cours d’écriture.', signature: null };
    return { state: 'error', message: 'Le fichier d’export est illisible, trop volumineux ou n’est pas un fichier ordinaire.', signature: null };
  }
  const settings = await exportSettings(source.canonical);
  if (!settings.valid) return { state: settings.state, message: settings.message, signature: source.signature };
  const value = source.value.replace(/\r\n?/g, '\n');
  if (!value.trim()) return { state: 'empty', signature: source.signature };
  const lines = value.split('\n'); while (lines.length > 3 && lines.at(-1) === '') lines.pop();
  if (lines.length !== 3) return { state: lines.length < 3 ? 'waiting' : 'unsupported', message: 'L’export doit contenir exactement trois lignes : titre, artiste et charter.', signature: source.signature };
  const [title, artist] = lines.slice(0, 2).map(normalize);
  const parsedCharter = parseColoredText(lines[2]), charter = normalize(parsedCharter.text);
  if (!title) return { state: 'waiting', message: 'Le titre exporté est vide ou incomplet.', signature: source.signature };
  const song = { title, ...(artist ? { artist } : {}), ...(charter ? { charter,
    ...(parsedCharter.segments && charter === parsedCharter.text ? { charterSegments: parsedCharter.segments } : {}) } : {}) };
  return { state: 'song', signature: source.signature, mtimeMs: source.mtimeMs, stableKey: source.signature + ':' + settings.signature, song };
}

/** Native text export is an activity proxy, never exact gameplay/process detection. */
async function createCloneHeroSource({ mock, dataDirectory, candidates = [], onChange = () => {}, pollIntervalMs = 500, resolveCharter, probeGame } = {}) {
  if (!absolute(dataDirectory) || ['connect', 'disconnect', 'getCurrentSong', 'getGameplayState', 'subscribe'].some(key => typeof mock?.[key] !== 'function') || !Array.isArray(candidates) || candidates.some(value => !absolute(value)) || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60000) throw safe('Configuration de la source Clone Hero invalide.');
  if (resolveCharter !== undefined && typeof resolveCharter !== 'function') throw safe('Configuration des couleurs du charter invalide.');
  if (probeGame !== undefined && typeof probeGame !== 'function') throw safe('Configuration de la détection de Clone Hero invalide.');
  const { parseColoredText, validateColoredTextSegments } = await import('./dist/core/types/ColoredText.js');
  const configFile = path.join(dataDirectory, 'clonehero.json'), choices = [...new Set(candidates)];
  let config = { version: 1, mode: 'mock', filePath: null }, protectedFile = null;
  let connected = false, wanted = false, epoch = 0, timer = null, mockConnected = false, unsubscribeMock = null, mockRevision = 0;
  let controls = Promise.resolve(), reads = Promise.resolve(), connectTask = null;
  let song = null, gameplay = idle(), baseline = null, candidate = null, nativeError = false, enrichment = null;
  let adoptedSignature = null, sessionKey = null, knownRunning = null;
  let state = 'disconnected', message = 'La source Clone Hero est arrêtée.', lastStatus = null;
  const listeners = new Set();
  function status() { return { mode: config.mode, filePath: config.filePath, status: state, message, capabilities: { ...CAPABILITIES } }; }
  function notify() {
    const value = status(), key = JSON.stringify(value); if (key === lastStatus) return; lastStatus = key;
    try { onChange(value); } catch { console.warn('La notification de la source Clone Hero a échoué.'); }
  }
  function diagnostic(nextState, nextMessage) { state = nextState; message = nextMessage; notify(); }
  function emit(event) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(event.type === 'song' ? { type: 'song', song: cloneSong(event.song) } : event.type === 'gameplay' ? { type: 'gameplay', gameplay: { ...event.gameplay } } : { type: 'error' }); }
      catch { console.warn('Un observateur de la source Clone Hero a échoué.'); }
    }
  }
  function publish(nextSong, nextGameplay, force = false) {
    const changedSong = JSON.stringify(song) !== JSON.stringify(nextSong), changedGameplay = JSON.stringify(gameplay) !== JSON.stringify(nextGameplay);
    song = cloneSong(nextSong); gameplay = { ...nextGameplay };
    if (force || changedGameplay) emit({ type: 'gameplay', gameplay });
    if (force || changedSong) emit({ type: 'song', song });
  }
  function clear(force = false) { enrichment?.controller.abort(); enrichment = null; publish(null, idle(), force); }
  function queue(action) { const operation = controls.then(action); controls = operation.catch(() => {}); return operation; }
  function read(filename) { const operation = reads.then(() => observation(filename, parseColoredText)); reads = operation.catch(() => {}); return operation; }
  async function processState() {
    const unknown = { running: null, sessions: [] };
    if (!probeGame) return unknown;
    let timeout;
    try {
      const value = await Promise.race([
        Promise.resolve().then(probeGame),
        new Promise(resolve => { timeout = setTimeout(() => resolve(unknown), 2500); }),
      ]);
      if (value?.running === false && Array.isArray(value.sessions) && value.sessions.length === 0) return { running: false, sessions: [] };
      if (value?.running !== true || !Array.isArray(value.sessions) || !value.sessions.length || value.sessions.length > 128 || value.sessions.some(session => !Number.isSafeInteger(session?.pid) || session.pid <= 0 || !Number.isFinite(session.startedAtMs) || session.startedAtMs <= 0)) return unknown;
      return { running: true, sessions: value.sessions.map(({ pid, startedAtMs }) => ({ pid, startedAtMs })).sort((a, b) => a.pid - b.pid || a.startedAtMs - b.startedAtMs) };
    } catch { return unknown; }
    finally { clearTimeout(timeout); }
  }
  function sample(filename) { return Promise.all([read(filename), processState()]); }
  function cancelTimer() { if (timer) clearTimeout(timer); timer = null; }
  function live(token) { return connected && wanted && config.mode === 'live' && token === epoch; }
  function arm(token) {
    if (!live(token)) return;
    timer = setTimeout(() => { timer = null; void poll(token); }, pollIntervalMs); timer.unref?.();
  }
  function enrichedSong(value) {
    const base = value.song;
    if (!resolveCharter || !base.charter || base.charterSegments) return base;
    const key = value.stableKey + '\0' + config.filePath;
    if (enrichment?.key === key && enrichment.epoch === epoch) return enrichment.segments ? { ...base, charterSegments: enrichment.segments } : base;
    enrichment?.controller.abort();
    const entry = { key, epoch, filePath: config.filePath, segments: undefined, controller: new AbortController() };
    enrichment = entry;
    // Keep polling and publishing plain metadata while local enrichment is
    // pending, so an empty export or a source switch clears immediately.
    Promise.resolve().then(() => {
      if (!live(entry.epoch) || enrichment !== entry || candidate?.key !== value.stableKey || state !== 'active') return undefined;
      return resolveCharter({ title: base.title, artist: base.artist, charter: base.charter }, entry.filePath, { signal: entry.controller.signal });
    }).then(result => {
      if (!live(entry.epoch) || enrichment !== entry || candidate?.key !== value.stableKey || state !== 'active') return;
      entry.segments = validateColoredTextSegments(result, base.charter);
      if (entry.segments) publish({ ...base, charterSegments: entry.segments }, { state: 'playing', isChartActive: true });
    }).catch(() => { console.warn('Les couleurs locales du charter ne sont pas disponibles.'); });
    return base;
  }
  function accept(value, process, initial = false) {
    if (initial) { baseline = value.signature; adoptedSignature = null; candidate = null; clear(); }
    if (process.running === false) {
      knownRunning = false; baseline = value.signature; adoptedSignature = null; candidate = null; clear();
      diagnostic('waiting', 'Clone Hero est fermé. En attente d’une nouvelle session.'); return;
    }
    if (process.running === true) {
      const key = JSON.stringify(process.sessions);
      if (initial || knownRunning === false || key !== sessionKey) {
        // A retained export is usable only when it was written in this game session.
        // Keep the two-observation check even when Companion opens mid-song.
        baseline = value.signature; candidate = null; clear();
        adoptedSignature = value.state === 'song' && process.sessions.some(session => value.mtimeMs >= session.startedAtMs - 5) ? value.signature : null;
      }
      knownRunning = true; sessionKey = key;
    }
    if (value.state !== 'song') {
      adoptedSignature = null; candidate = null; clear();
      if (value.signature !== null) baseline = value.signature;
      const failure = value.state === 'error';
      if (failure && !nativeError) emit({ type: 'error' });
      else if (!failure && nativeError) emit({ type: 'gameplay', gameplay });
      nativeError = failure;
      diagnostic(value.state === 'empty' ? 'waiting' : value.state, value.state === 'empty' ? 'Aucun titre exporté. En attente d’un chart.' : value.message);
      return;
    }
    if ((initial || value.signature === baseline) && value.signature !== adoptedSignature) {
      candidate = null; clear(); diagnostic('waiting', 'Export présent. En attente d’une nouvelle écriture de Clone Hero pour éviter un ancien titre.'); return;
    }
    if (!candidate || candidate.key !== value.stableKey) {
      candidate = { key: value.stableKey, count: 1 }; clear(); diagnostic('waiting', 'Nouvel export détecté. Vérification de sa stabilité.'); return;
    }
    candidate.count++;
    if (candidate.count >= 2) {
      const recovered = nativeError; nativeError = false;
      publish(enrichedSong(value), { state: 'playing', isChartActive: true }, recovered);
      diagnostic('active', 'Export actif : titre, artiste et charter disponibles. L’état de jeu et la pause restent inconnus.');
    }
  }
  async function poll(token) {
    try { const [value, process] = await sample(config.filePath); if (live(token)) accept(value, process); }
    catch { if (live(token)) accept({ state: 'error', message: 'La lecture de l’export Clone Hero a échoué.', signature: null }, { running: null, sessions: [] }); }
    finally { arm(token); }
  }
  async function detachMock() {
    unsubscribeMock?.(); unsubscribeMock = null;
    if (mockConnected) { mockConnected = false; await mock.disconnect(); }
  }
  async function restart() {
    const token = ++epoch; cancelTimer(); unsubscribeMock?.(); unsubscribeMock = null; candidate = null; baseline = null; adoptedSignature = null; sessionKey = null; knownRunning = null; nativeError = false; clear(true);
    await detachMock();
    if (!wanted || token !== epoch) { connected = false; diagnostic('disconnected', 'La source Clone Hero est arrêtée.'); return; }
    connected = true;
    if (config.mode === 'mock') {
      unsubscribeMock = mock.subscribe(event => {
        if (!connected || !wanted || config.mode !== 'mock' || token !== epoch) return;
        mockRevision++;
        if (event.type === 'gameplay') publish(song, event.gameplay);
        else if (event.type === 'song') publish(event.song, gameplay);
        else if (event.type === 'error') { clear(); emit({ type: 'error' }); }
      });
      await mock.connect(); mockConnected = true;
      if (!connected || !wanted || config.mode !== 'mock' || token !== epoch) { await detachMock(); return; }
      const expected = mockRevision, [currentSong, currentGameplay] = await Promise.all([mock.getCurrentSong(), mock.getGameplayState()]);
      if (connected && wanted && config.mode === 'mock' && token === epoch && expected === mockRevision) publish(currentSong, currentGameplay);
      if (token === epoch && wanted) diagnostic('mock', 'Démonstration déterministe : aucune donnée du jeu réel.');
    } else {
      diagnostic('waiting', 'Vérification du fichier d’export natif.');
      const [value, process] = await sample(config.filePath);
      if (live(token)) { accept(value, process, true); arm(token); }
    }
  }
  async function save(next) {
    if (protectedFile) throw safe('La configuration de la source est illisible ou provient d’une version plus récente. Le fichier original reste protégé.');
    await fs.mkdir(dataDirectory, { recursive: true }); const temporary = configFile + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(next), 'utf8'); await handle.sync(); await handle.close(); handle = null;
      try { await fs.copyFile(configFile, configFile + '.bak'); } catch (problem) { if (problem?.code !== 'ENOENT') throw problem; }
      await fs.rename(temporary, configFile);
    } catch { throw safe('Impossible d’enregistrer les réglages de la source Clone Hero.'); }
    finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(problem => { if (problem?.code !== 'ENOENT') console.warn('Le fichier temporaire de la source n’a pas pu être nettoyé.'); }); }
  }
  async function choose(filename) {
    if (!absolute(filename)) throw safe('Fichier d’export Clone Hero invalide.');
    try { return (await readFile(filename)).canonical; }
    catch { throw safe('Choisissez un fichier d’export ordinaire, lisible et inférieur à 64 Ko.'); }
  }
  async function findCandidate() {
    for (const filename of choices) {
      try { const canonical = await choose(filename), value = await observation(canonical, parseColoredText); if (['song', 'empty', 'waiting'].includes(value.state)) return canonical; }
      catch { /* Other configured candidates may still be valid. */ }
    }
    return null;
  }
  try {
    const stored = await readFile(configFile, CONFIG_BYTES), value = JSON.parse(stored.value);
    if (!object(value) || value.version !== 1 || !['live', 'mock'].includes(value.mode) || !(value.filePath === null || absolute(value.filePath)) || Object.keys(value).some(key => !['version', 'mode', 'filePath'].includes(key))) throw Error('Invalid source configuration');
    config = { version: 1, mode: value.mode, filePath: value.filePath };
  } catch (problem) {
    if (problem?.code !== 'ENOENT') { protectedFile = true; diagnostic('error', 'La configuration de la source est illisible ou provient d’une version plus récente. Le fichier original est conservé.'); }
    else { const found = await findCandidate(); if (found) config = { version: 1, mode: 'live', filePath: found }; }
  }
  if (!protectedFile) diagnostic(config.mode === 'mock' ? 'mock' : 'disconnected', config.mode === 'mock' ? 'Démonstration déterministe : aucune donnée du jeu réel.' : 'Export natif détecté. La source est arrêtée.');

  async function connect() {
    if (connectTask) return connectTask;
    if (wanted && connected) return;
    wanted = true;
    connectTask = queue(async () => { if (wanted && !connected) await restart(); });
    try { await connectTask; } finally { connectTask = null; }
  }
  async function disconnect() {
    wanted = false; connected = false; epoch++; cancelTimer(); unsubscribeMock?.(); unsubscribeMock = null; clear(true); diagnostic('disconnected', 'La source Clone Hero est arrêtée.');
    await queue(detachMock);
  }
  function setMode(mode) {
    return queue(async () => {
      if (!['live', 'mock'].includes(mode)) throw safe('Mode de source Clone Hero invalide.');
      if (mode === config.mode) return status();
      const next = { ...config, mode }; await save(next); config = next; await restart(); return status();
    });
  }
  function selectFile(filename) {
    return queue(async () => {
      const canonical = await choose(filename), next = { version: 1, mode: 'live', filePath: canonical };
      await save(next); config = next; await restart(); return status();
    });
  }
  function detect() {
    return queue(async () => {
      const found = await findCandidate();
      if (!found) { diagnostic(config.mode === 'mock' ? 'mock' : 'missing', 'Aucun export natif utilisable détecté. Activez l’export dans Clone Hero puis sélectionnez currentsong.txt.'); return status(); }
      const next = { version: 1, mode: 'live', filePath: found }; await save(next); config = next; await restart(); return status();
    });
  }
  function mockControl(name, ...args) {
    if (config.mode !== 'mock') throw safe('Les commandes de démonstration sont disponibles uniquement en mode mock.');
    if (typeof mock[name] !== 'function') throw safe('Cette commande de démonstration n’est pas disponible.');
    return mock[name](...args);
  }
  return {
    connect, disconnect, status, setMode, selectFile, detect,
    async getCurrentSong() { return connected ? cloneSong(song) : null; },
    async getGameplayState() { return connected ? { ...gameplay } : idle(); },
    subscribe(listener) { if (typeof listener !== 'function') throw safe('Observateur de source invalide.'); listeners.add(listener); return () => listeners.delete(listener); },
    step: () => mockControl('step'), reset: () => mockControl('reset'), transition: value => mockControl('transition', value)
  };
}
module.exports = { createCloneHeroSource };
