'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createCloneHeroProcessProbe } = require('./clonehero-process.cjs');
const downloads = require('./reshade-downloads.cjs');

const JOURNAL = 'ChartsHubReShade.setup.json';
const ADDON = 'ChartsHubReShade.addon64';
const BRIDGE_JOURNAL = 'ChartsHubReShade.install.json';
const PACK = 'ChartsHub-ReShade-Shaders';
const PRESET = 'ChartsHub-ReShade-Preset.ini';
const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const safe = message => Object.assign(Error(message), { code: 'RESHADE_SETUP_SAFE' });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const validHash = value => value === null || /^[a-f0-9]{64}$/.test(value);
const allowed = name => ['dxgi.dll', 'ReShade.ini', ADDON, BRIDGE_JOURNAL, PRESET, 'ChartsHub-ReShade-README.txt'].includes(name)
  || (typeof name === 'string' && /^ChartsHub-ReShade-Shaders\/(?:Shaders|Licenses)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(name));

async function regular(file, max = 64 * 1024 * 1024) {
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw safe('Un fichier du jeu est invalide ou a été remplacé.');
  return fs.readFile(file);
}
function isX64(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0' && bytes.readUInt16LE(offset + 4) === 0x8664;
}
async function checkedRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw safe('Choisissez le dossier contenant Clone Hero.exe.');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safe('Choisissez le dossier réel de Clone Hero.');
  const root = await fs.realpath(directory);
  const exe = await regular(path.join(root, 'Clone Hero.exe'), 128 * 1024 * 1024);
  if (!isX64(exe)) throw safe('Cet assistant nécessite Clone Hero Windows 64 bits.');
  const unity = await fs.lstat(path.join(root, 'UnityPlayer.dll')).catch(() => null);
  if (!unity?.isFile() || unity.isSymbolicLink()) throw safe('UnityPlayer.dll est absent du dossier choisi.');
  return { root, exeHash: digest(exe) };
}
async function target(root, name, create = false) {
  if (!allowed(name) && name !== JOURNAL) throw safe('Chemin d’installation invalide.');
  let directory = root;
  const segments = name.split('/');
  for (const part of segments.slice(0, -1)) {
    directory = path.join(directory, part);
    if (create) await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!stat) return path.join(root, ...segments);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw safe('Un dossier de shaders a été remplacé par un lien ou un fichier.');
  }
  return path.join(root, ...segments);
}
async function readTarget(root, name) { return regular(await target(root, name)); }
async function atomic(root, name, bytes, expected) {
  const file = await target(root, name, true), temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await target(root, name);
    if (expected !== undefined && digest(await regular(file)) !== expected) throw safe('Les fichiers du jeu ont changé. Préparez de nouveau l’installation.');
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function parseJournal(bytes) {
  if (!bytes) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw safe('Le journal d’installation est illisible. Il est conservé.'); }
  if (!value || value.version !== 1 || !['installing', 'complete', 'rolled-back'].includes(value.phase)
      || !/^ChartsHub-ReShade-backup-[a-f0-9-]{36}$/.test(value.backup)
      || !Array.isArray(value.files) || value.files.length > 40 || new Set(value.files.map(item => item?.relativePath)).size !== value.files.length
      || value.files.some((item, index) => !item || !allowed(item.relativePath) || !validHash(item.beforeHash) || !/^[a-f0-9]{64}$/.test(item.afterHash)
        || item.backupFile !== (item.beforeHash === null ? null : index + '.bin'))) throw safe('Le journal d’installation est invalide. Il est conservé.');
  return value;
}

// Only append our search directory. Preserve unrelated INI lines, comments and preset selection.
function addShaderPath(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw safe('ReShade.ini utilise un encodage non pris en charge. Il est conservé.'); }
  const bom = source.startsWith('\ufeff') ? '\ufeff' : '', nl = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.slice(bom.length).split(/\r?\n/), required = '.\\' + PACK + '\\Shaders';
  let general = -1, end = lines.length, search = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[GENERAL\]\s*$/i.test(lines[i])) { if (general >= 0) throw safe('ReShade.ini contient plusieurs sections GENERAL. Il est conservé.'); general = i; }
  }
  if (general >= 0) {
    for (let i = general + 1; i < lines.length; i++) { if (/^\s*\[/.test(lines[i])) { end = i; break; } }
    for (let i = general + 1; i < end; i++) if (/^\s*EffectSearchPaths\s*=/i.test(lines[i])) {
      if (search >= 0) throw safe('ReShade.ini contient plusieurs chemins de shaders ambigus. Il est conservé.');
      search = i;
    }
  }
  const normalize = value => value.trim().replaceAll('/', '\\').replace(/^\.\\/, '').replace(/\\+$/, '').toLowerCase();
  if (search >= 0) {
    const values = lines[search].slice(lines[search].indexOf('=') + 1).split(',');
    if (values.some(value => normalize(value) === normalize(required))) return bytes;
    lines[search] += (values.some(value => value.trim()) ? ',' : '') + required;
  } else if (general >= 0) lines.splice(end, 0, 'EffectSearchPaths=.\\reshade-shaders\\Shaders\\**,' + required);
  else lines.push('[GENERAL]', 'EffectSearchPaths=.\\reshade-shaders\\Shaders\\**,' + required, '');
  return Buffer.from(bom + lines.join(nl));
}

function validateAddonConfig(bytes, root) {
  if (!bytes) return;
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw safe('ReShade.ini utilise un encodage non pris en charge. Il est conservé.'); }
  let section = '', addonSection = false;
  const seen = new Set();
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) {
      section = heading[1].toUpperCase();
      if (section === 'ADDON') {
        if (addonSection) throw safe('ReShade.ini contient plusieurs sections ADDON. Il est conservé.');
        addonSection = true;
      }
      continue;
    }
    if (section !== 'ADDON') continue;
    const setting = line.match(/^\s*(AddonPath|DisabledAddons)\s*=(.*)$/i);
    if (!setting) continue;
    const key = setting[1].toLowerCase(), value = setting[2].trim();
    if (seen.has(key)) throw safe('La configuration des add-ons est ambiguë. ReShade.ini est conservé.');
    seen.add(key);
    if (key === 'addonpath' && !samePath(path.resolve(root, value.replaceAll('\\', path.sep)), root)) throw safe('ReShade charge ses add-ons depuis un autre dossier (AddonPath). Choisissez le dossier du jeu dans ce réglage ReShade avant de continuer.');
    if (key === 'disabledaddons' && value.split(',').some(item => {
      const token = item.trim(), separator = token.indexOf('@');
      return token === 'ChartsHub ReShade Bridge' || (separator >= 0 && token.slice(separator + 1) === ADDON);
    })) throw safe('Le pont ChartsHub est désactivé dans ReShade (DisabledAddons). Réactivez-le avant de continuer.');
  }
}

function createReShadeSetupService({ dataDirectory, reshadeService, onChange = () => {}, platform = process.platform,
  addonBinaryPath = path.join(__dirname, '..', 'reshade-bridge', 'bin', ADDON),
  downloadRuntime = downloads.downloadRuntime, downloadStarterEffects = downloads.downloadStarterEffects,
  probeClosed, beforeWrite = async () => {} } = {}) {
  let disposed = false, controller = null, prepared = null, active = null;
  let current = { state: 'idle', busy: false, rootPath: null, includeStarterEffects: false, version: downloads.RUNTIME_VERSION,
    message: 'Préparez ReShade pour cette installation de Clone Hero.', error: null, progress: null, files: [] };
  const status = () => structuredClone(current);
  const publish = patch => { Object.assign(current, patch); if (!disposed) onChange(status()); };
  async function closed() {
    const value = await (probeClosed || createCloneHeroProcessProbe())();
    if (value?.running !== false) throw safe(value?.running ? 'Fermez Clone Hero avant l’installation.' : 'La fermeture de Clone Hero ne peut pas être vérifiée. Réessayez.');
  }
  async function verifyRoot(plan) {
    if (!samePath(reshadeService?.status().rootPath, plan.root)) throw safe('Le dossier sélectionné a changé. Préparez de nouveau l’installation.');
    const value = await checkedRoot(plan.root);
    if (value.root !== plan.root || value.exeHash !== plan.exeHash) throw safe('L’installation du jeu a changé. Préparez de nouveau les fichiers.');
  }
  async function rollback(root, journal) {
    await closed();
    const directory = path.join(root, journal.backup), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(directory)) !== root) throw safe('La sauvegarde a été remplacée. Aucun fichier restauré.');
    const restore = [];
    // Validate every backup and every destination before restoring even the first file.
    for (const item of journal.files) {
      const original = item.backupFile === null ? null : await regular(path.join(directory, item.backupFile));
      if (digest(original) !== item.beforeHash) throw safe('Une sauvegarde est invalide. Aucun fichier restauré.');
      const existing = digest(await readTarget(root, item.relativePath));
      if (existing !== item.beforeHash && existing !== item.afterHash) throw safe('Un fichier a été modifié après l’installation interrompue. La sauvegarde est conservée : ' + journal.backup);
      if (existing !== item.beforeHash) restore.push({ ...item, original });
    }
    for (const item of restore.reverse()) {
      if (item.original !== null) await atomic(root, item.relativePath, item.original, item.afterHash);
      else {
        const file = await target(root, item.relativePath);
        if (digest(await regular(file)) !== item.afterHash) throw safe('Un fichier a changé pendant la restauration. La sauvegarde est conservée.');
        await fs.unlink(file);
      }
    }
    await atomic(root, JOURNAL, Buffer.from(JSON.stringify({ ...journal, phase: 'rolled-back' }, null, 2) + '\n'));
  }
  function run(state, action) {
    if (disposed || active) return Promise.reject(safe('Une opération est déjà en cours ou le panneau est fermé.'));
    if (state === 'preparing') controller = new AbortController();
    publish({ state, busy: true, error: null, progress: null });
    const task = Promise.resolve().then(action).catch(error => {
      prepared = null;
      if (error.name === 'AbortError') { publish({ state: 'idle', message: 'Préparation annulée.', error: null, files: [] }); return; }
      const message = error.code === 'RESHADE_SETUP_SAFE' || error.code === 'RESHADE_DOWNLOAD_SAFE' ? error.message : 'L’installation a échoué. Vérifiez la connexion Internet et les permissions du dossier.';
      publish({ state: 'error', error: message, message }); throw safe(message);
    }).finally(() => { active = null; controller = null; publish({ busy: false, progress: null }); });
    active = task; return task;
  }
  return {
    status,
    async load() { return status(); },
    prepare(options) {
      if (!options || Object.keys(options).sort().join(',') !== 'includeStarterEffects' || typeof options.includeStarterEffects !== 'boolean') return Promise.reject(safe('Options d’installation invalides.'));
      return run('preparing', async () => {
        prepared = null;
        const signal = controller.signal;
        if (platform !== 'win32') throw safe('Cet assistant est disponible sur Windows 64 bits.');
        const info = await checkedRoot(reshadeService?.status().rootPath);
        signal.throwIfAborted();
        publish({ rootPath: info.root, includeStarterEffects: options.includeStarterEffects, files: [], message: 'Vérification du dossier du jeu…' });
        const previous = parseJournal(await readTarget(info.root, JOURNAL));
        if (previous?.phase === 'installing') { await verifyRoot(info); await rollback(info.root, previous); }
        const proxy = await readTarget(info.root, 'dxgi.dll');
        if (proxy && (!isX64(proxy) || !proxy.includes(Buffer.from('ReShadeRegisterAddon')))) throw safe('Un autre module graphique est présent. Restaurez-le depuis les filtres ChartsHub avant d’utiliser cet assistant.');
        if (await regular(path.join(info.root, 'd3d11.dll'))) throw safe('Un autre module d3d11.dll est présent. Il est conservé ; vérifiez cette installation avant de continuer.');
        const existingIni = await readTarget(info.root, 'ReShade.ini');
        validateAddonConfig(existingIni, info.root);
        const existingAddon = await readTarget(info.root, ADDON), bridgeManifest = await readTarget(info.root, BRIDGE_JOURNAL);
        if (existingAddon) {
          let value; try { value = JSON.parse(bridgeManifest?.toString('utf8')); } catch { /* Rejected below. */ }
          if (!value || value.version !== 1 || !['prepared', 'installed'].includes(value.phase)
            || (digest(existingAddon) !== value.moduleHash && !(value.phase === 'prepared' && digest(existingAddon) === value.previousHash))) throw safe('Un autre pont ChartsHub est présent. Il est conservé.');
        } else if (bridgeManifest) throw safe('Le pont ChartsHub est incomplet. Réparez-le avec « Connecter ReShade » avant de continuer.');
        const addon = await regular(addonBinaryPath);
        if (!isX64(addon)) throw safe('Le pont ChartsHub compilé est absent de cette version.');
        signal.throwIfAborted();
        let lastProgressAt = 0, lastProgressLabel = null;
        const onProgress = progress => {
          if (signal.aborted) return;
          const now = Date.now();
          if (progress.label !== lastProgressLabel || now - lastProgressAt >= 100 || progress.received === progress.total) {
            lastProgressAt = now; lastProgressLabel = progress.label;
            publish({ progress, message: progress.label || 'Téléchargement…' });
          }
        };
        const runtime = await downloadRuntime({ onProgress, signal });
        signal.throwIfAborted();
        if (!isX64(runtime) || !runtime.includes(Buffer.from('ReShadeRegisterAddon'))) throw safe('Le moteur ReShade téléchargé est invalide.');
        const starter = options.includeStarterEffects ? await downloadStarterEffects({ onProgress, signal }) : [];
        signal.throwIfAborted();
        if (!Array.isArray(starter) || starter.length > 30 || starter.some(item => !item || !allowed(item.relativePath)
          || !item.relativePath.startsWith(PACK + '/') || !Buffer.isBuffer(item.bytes) || item.bytes.length > 2 * 1024 * 1024)
          || new Set(starter.map(item => item.relativePath.toLowerCase())).size !== starter.length) throw safe('Le pack d’effets téléchargé est invalide.');
        const files = [];
        async function add(relativePath, bytes, preserve = false) {
          const original = await readTarget(info.root, relativePath);
          if (digest(original) === digest(bytes)) return;
          if (preserve && original !== null) throw safe('Un fichier du pack a été modifié. Il est conservé : ' + relativePath);
          files.push({ relativePath, bytes, original, beforeHash: digest(original), afterHash: digest(bytes) });
        }
        await add('dxgi.dll', runtime);
        let ini = existingIni;
        if (!ini) {
          ini = Buffer.from('[GENERAL]\r\nPerformanceMode=0\r\nSkipLoadingDisabledEffects=0\r\nPresetPath=.\\' + PRESET + '\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\nTextureSearchPaths=.\\reshade-shaders\\Textures\\**\r\n');
          if (!await readTarget(info.root, PRESET)) await add(PRESET, Buffer.from('Techniques=\r\nTechniqueSorting=\r\n'));
        }
        if (options.includeStarterEffects) ini = addShaderPath(ini);
        await add('ReShade.ini', ini);
        for (const item of starter) await add(item.relativePath, item.bytes, true);
        await add(ADDON, addon);
        await add(BRIDGE_JOURNAL, Buffer.from(JSON.stringify({ version: 1, phase: 'installed', moduleHash: digest(addon), previousHash: digest(existingAddon) }, null, 2)));
        const notice = Buffer.from('ReShade ' + downloads.RUNTIME_VERSION + ' avec prise en charge des add-ons\r\nAuteur : crosire et contributeurs — https://reshade.me/\r\nTéléchargement officiel effectué à votre demande par ChartsHub.\r\nLes notices du moteur sont conservées dans la DLL et la licence ReShade est fournie avec ChartsHub.\r\nLes licences des effets optionnels se trouvent dans ChartsHub-ReShade-Shaders/Licenses.\r\nAucun effet n’est activé automatiquement. Les presets existants sont conservés.\r\n');
        if (!await readTarget(info.root, 'ChartsHub-ReShade-README.txt')) await add('ChartsHub-ReShade-README.txt', notice);
        signal.throwIfAborted();
        await verifyRoot(info);
        prepared = { ...info, files, journalHash: digest(await readTarget(info.root, JOURNAL)), proxyHash: digest(proxy),
          addonHash: digest(existingAddon), bridgeHash: digest(bridgeManifest), iniHash: digest(existingIni) };
        publish({ state: 'ready', files: files.map(item => item.relativePath), message: files.length ? 'Fichiers prêts. Fermez Clone Hero, puis installez dans le dossier affiché.' : 'ReShade et les fichiers choisis sont déjà installés.' });
      });
    },
    install() {
      if (!prepared || current.state !== 'ready') return Promise.reject(safe('Préparez d’abord les fichiers à installer.'));
      const plan = prepared;
      return run('installing', async () => {
        await verifyRoot(plan); await closed();
        for (const [name, expected] of [['dxgi.dll', plan.proxyHash], [ADDON, plan.addonHash], [BRIDGE_JOURNAL, plan.bridgeHash], ['ReShade.ini', plan.iniHash], [JOURNAL, plan.journalHash]]) {
          if (digest(await readTarget(plan.root, name)) !== expected) throw safe('La configuration du jeu a changé. Préparez de nouveau les fichiers.');
        }
        if (await regular(path.join(plan.root, 'd3d11.dll'))) throw safe('Un module graphique est apparu. Préparez de nouveau les fichiers.');
        for (const item of plan.files) if (digest(await readTarget(plan.root, item.relativePath)) !== item.beforeHash) throw safe('Un fichier a changé depuis la préparation. Aucun remplacement effectué.');
        if (plan.files.length) {
          const backup = 'ChartsHub-ReShade-backup-' + randomUUID(), directory = path.join(plan.root, backup);
          await fs.mkdir(directory);
          const journal = { version: 1, phase: 'installing', runtimeVersion: downloads.RUNTIME_VERSION, backup,
            files: plan.files.map((item, index) => ({ relativePath: item.relativePath, beforeHash: item.beforeHash, afterHash: item.afterHash, backupFile: item.original === null ? null : index + '.bin' })) };
          for (let i = 0; i < plan.files.length; i++) if (plan.files[i].original !== null) await fs.writeFile(path.join(directory, i + '.bin'), plan.files[i].original, { flag: 'wx' });
          await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(journal, null, 2), { flag: 'wx' });
          await verifyRoot(plan); await closed();
          await atomic(plan.root, JOURNAL, Buffer.from(JSON.stringify(journal, null, 2) + '\n'), plan.journalHash);
          try {
            for (let index = 0; index < plan.files.length; index++) {
              const item = plan.files[index];
              await beforeWrite({ relativePath: item.relativePath, index });
              await verifyRoot(plan);
              await atomic(plan.root, item.relativePath, item.bytes, item.beforeHash);
            }
            await atomic(plan.root, JOURNAL, Buffer.from(JSON.stringify({ ...journal, phase: 'complete' }, null, 2) + '\n'));
          } catch (error) {
            try { await rollback(plan.root, journal); }
            catch { throw safe('Installation interrompue. Les sauvegardes sont conservées dans ' + backup + '. Fermez le jeu puis préparez de nouveau pour récupérer les fichiers.'); }
            throw error;
          }
        }
        prepared = null;
        await reshadeService.refresh().catch(() => {});
        publish({ state: 'complete', message: 'ReShade est installé. Lancez Clone Hero, puis activez les effets souhaités dans ChartsHub.' });
      });
    },
    async cancel() {
      if (current.state === 'installing') throw safe('L’installation est en cours. Attendez sa fin.');
      controller?.abort();
      if (active) await active.catch(() => {});
      prepared = null;
      publish({ state: 'idle', busy: false, error: null, progress: null, files: [], message: 'Préparation annulée.' });
    },
    async whenIdle() { if (active) await active.catch(() => {}); },
    async dispose() { disposed = true; if (current.state !== 'installing') controller?.abort(); if (active) await active.catch(() => {}); prepared = null; }
  };
}
module.exports = { createReShadeSetupService, addShaderPath };
