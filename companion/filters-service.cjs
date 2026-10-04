'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createCloneHeroProcessProbe } = require('./clonehero-process.cjs');

const DEFAULTS = Object.freeze({ enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 });
const RANGES = Object.freeze({ saturation: [0, 2], contrast: [.5, 2], gamma: [.5, 2.5], exposure: [-2, 2], sharpness: [0, 1], vignette: [0, 1] });
const MANIFEST = 'ChartsHubFilters.install.json', CONFIG = 'ChartsHubFilters.ini', STATUS = 'ChartsHubFilters.status.ini';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = message => Object.assign(Error(message), { code: 'FILTERS_SAFE' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validateSettings(value) {
  if (!object(value) || Object.keys(value).length !== Object.keys(DEFAULTS).length || Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key)) || typeof value.enabled !== 'boolean') throw safe('Réglages de filtres invalides.');
  for (const [key, [min, max]] of Object.entries(RANGES)) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw safe('Réglage de filtre hors limites.');
  return { ...value };
}
function encodeSettings(settings) {
  const value = validateSettings(settings);
  return '[Filters]\r\n' + Object.entries(value).map(([key, item]) => key + '=' + (typeof item === 'boolean' ? Number(item) : item)).join('\r\n') + '\r\n';
}
async function regular(filename, maxBytes = 32 * 1024 * 1024) {
  let stat;
  try { stat = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw safe('Un fichier du module est invalide ou a été remplacé.');
  return fs.readFile(filename);
}
async function atomic(filename, bytes) {
  await regular(filename);
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function checkedRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw safe('Choisissez le dossier contenant Clone Hero.exe.');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safe('Choisissez un dossier de jeu réel, sans lien symbolique.');
  const root = await fs.realpath(directory);
  const executable = await regular(path.join(root, 'Clone Hero.exe'), 128 * 1024 * 1024);
  if (!executable || executable.length < 64 || executable.toString('ascii', 0, 2) !== 'MZ') throw safe('Clone Hero.exe est absent ou invalide dans ce dossier.');
  const offset = executable.readUInt32LE(0x3c);
  if (offset + 6 > executable.length || executable.toString('ascii', offset, offset + 4) !== 'PE\0\0' || executable.readUInt16LE(offset + 4) !== 0x8664) throw safe('Le module de filtres nécessite Clone Hero Windows 64 bits.');
  const unity = await fs.lstat(path.join(root, 'UnityPlayer.dll')).catch(() => null);
  if (!unity?.isFile() || unity.isSymbolicLink()) throw safe('Le dossier sélectionné ne contient pas le moteur de Clone Hero.');
  return root;
}
function parseManifest(bytes) {
  if (!bytes) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw safe('La sauvegarde du module ne peut pas être lue.'); }
  if (!object(value) || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.moduleHash) || !/^ChartsHubFilters-backup-[a-f0-9-]{36}$/.test(value.backup) || !object(value.originals)
    || Object.keys(value.originals).some(name => !['dxgi.dll', CONFIG, STATUS].includes(name))
    || !['dxgi.dll', CONFIG, STATUS].every(name => Object.hasOwn(value.originals, name) && (value.originals[name] === null || /^[a-f0-9]{64}$/.test(value.originals[name])))
    || !['prepared', 'installed', 'restored'].includes(value.phase)) throw safe('La sauvegarde du module est invalide.');
  return value;
}
function parseStatus(bytes, modified, probe, now) {
  if (!bytes || now - modified < -2000 || now - modified > 5000 || probe.running !== true) return null;
  const values = {}; let section = '';
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (/^\[.*\]$/.test(line.trim())) { section = line.trim(); continue; }
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (section === '[Status]' && match) values[match[1]] = match[2];
  }
  const pid = Number(values.pid), frames = Number(values.frames);
  if (values.protocol !== '1' || !Number.isSafeInteger(pid) || !probe.sessions.some(session => session.pid === pid && (!session.startedAtMs || modified >= session.startedAtMs)) || !Number.isSafeInteger(frames) || frames < 0) return null;
  return { pid, frames, ready: values.ready === '1' && frames > 0, enabled: values.enabled === '1', error: (values.error || '').replace(/[\x00-\x1f]/g, '').slice(0, 160) };
}

function createFiltersService({ dataDirectory, onChange = () => {}, nativeBinaryPath = path.join(__dirname, '..', 'native-filters', 'bin', 'dxgi.dll'), platform = process.platform, probeGame = createCloneHeroProcessProbe(), now = Date.now } = {}) {
  const file = path.join(dataDirectory, 'filters.json');
  let rootPath = null, settings = { ...DEFAULTS }, busy = false, disposed = false, persistenceInvalid = false, tail = Promise.resolve(), refreshTask = null;
  let current = { rootPath, settings, supported: platform === 'win32', binaryAvailable: false, installed: false, restoreAvailable: false, reshadePresent: false, state: 'unconfigured', message: 'Choisissez le dossier de Clone Hero.', error: null, running: null, busy, native: null };
  // Keep cross-service host broadcasts from exposing half-finished inspection
  // or settings changes while asynchronous checks are still pending.
  let confirmed = structuredClone({ ...current, rootPath, settings });
  const status = () => structuredClone({ ...confirmed, busy });
  const publish = ({ commit = true } = {}) => {
    if (commit) confirmed = structuredClone({ ...current, rootPath, settings });
    if (!disposed) onChange(status());
  };
  async function persist(nextRoot = rootPath, nextSettings = settings) {
    if (persistenceInvalid) throw safe('Le fichier de réglages invalide est conservé. Déplacez filters.json hors du dossier de profil avant de rouvrir le panneau.');
    await fs.mkdir(dataDirectory, { recursive: true }); await atomic(file, JSON.stringify({ version: 1, rootPath: nextRoot, settings: nextSettings }, null, 2) + '\n');
  }
  async function inspect() {
    if (persistenceInvalid) return;
    let bundle = null;
    try { bundle = await regular(nativeBinaryPath); } catch { /* Not a usable build. */ }
    current = { ...current, binaryAvailable: Boolean(bundle?.length), installed: false, restoreAvailable: false, reshadePresent: false, native: null, error: null };
    if (platform !== 'win32') { current.state = 'unconfigured'; current.message = 'Les filtres du jeu sont disponibles sur Windows 64 bits.'; return; }
    if (!rootPath) { current.state = 'unconfigured'; current.message = 'Choisissez le dossier de Clone Hero.'; return; }
    await checkedRoot(rootPath);
    const probe = await probeGame(); current.running = probe.running;
    const [dll, manifestBytes, reshade] = await Promise.all([regular(path.join(rootPath, 'dxgi.dll')), regular(path.join(rootPath, MANIFEST), 16384), regular(path.join(rootPath, 'ReShade.ini'), 1024 * 1024)]);
    const manifest = parseManifest(manifestBytes);
    current.restoreAvailable = Boolean(manifest && manifest.phase !== 'restored');
    current.installed = Boolean(dll && manifest && manifest.phase !== 'restored' && hash(dll) === manifest.moduleHash);
    current.reshadePresent = Boolean(reshade && dll && !current.installed);
    if (manifest?.phase === 'prepared' && !current.installed) { current.state = 'error'; current.error = 'Installation interrompue. Utilisez Restaurer pour retrouver la configuration précédente.'; current.message = current.error; return; }
    if (!current.installed) { current.state = 'not-installed'; current.message = current.reshadePresent ? 'ReShade détecté. Le module ChartsHub peut le remplacer après fermeture du jeu.' : 'Le module ChartsHub n’est pas installé dans ce jeu.'; return; }
    const statusFile = path.join(rootPath, STATUS);
    const bytes = await regular(statusFile, 8192);
    if (bytes) current.native = parseStatus(bytes, (await fs.stat(statusFile)).mtimeMs, probe, now());
    current.state = current.native?.ready ? 'ready' : 'restart-required';
    current.message = current.native?.ready ? (current.native.enabled ? 'Les filtres ChartsHub sont actifs dans le jeu.' : 'Le moteur ChartsHub est connecté. Les filtres sont désactivés.')
      : current.native && !current.native.enabled ? 'Le moteur ChartsHub est chargé. Activez les filtres pour traiter l’image du jeu.'
      : 'Module installé. Lancez Clone Hero en Direct3D 11 pour connecter les filtres.';
    if (current.native?.error) { current.state = 'error'; current.error = current.native.error; current.message = 'Le moteur graphique a signalé une erreur.'; }
  }
  function operation(action) {
    const next = tail.then(async () => {
      if (disposed) throw safe('Le panneau des filtres est fermé.');
      busy = true; publish({ commit: false });
      try { const result = await action(); await inspect(); return result; }
      catch (error) { current.state = 'error'; current.error = error.code === 'FILTERS_SAFE' ? error.message : 'Opération impossible. Vérifiez les fichiers du jeu et les droits d’accès.'; current.message = current.error; throw safe(current.error); }
      finally { busy = false; publish(); }
    });
    tail = next.catch(() => {}); return next;
  }
  async function requireClosed() {
    const probe = await probeGame();
    if (probe.running !== false) throw safe(probe.running ? 'Fermez Clone Hero avant d’installer ou de restaurer le module.' : 'La fermeture de Clone Hero ne peut pas être vérifiée. Réessayez avant de modifier le module.');
  }
  async function backupFiles(manifest) {
    const dir = path.join(rootPath, manifest.backup);
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(dir)) !== rootPath) throw safe('Le dossier de sauvegarde a été déplacé ou remplacé.');
    const files = {};
    for (const [name, expected] of Object.entries(manifest.originals)) {
      files[name] = expected === null ? null : await regular(path.join(dir, name));
      if (expected !== null && (!files[name] || hash(files[name]) !== expected)) throw safe('La sauvegarde a changé. La restauration est interrompue pour préserver les fichiers actuels.');
    }
    return files;
  }
  return {
    status,
    async load() {
      return operation(async () => {
        persistenceInvalid = true;
        const bytes = await regular(file, 16384);
        if (bytes) {
          let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw safe('Les réglages des filtres sont illisibles. Leur fichier original est conservé.'); }
          if (!object(data) || data.version !== 1 || (data.rootPath !== null && (typeof data.rootPath !== 'string' || !path.isAbsolute(data.rootPath)))) throw safe('Les réglages des filtres sont invalides.');
          settings = validateSettings(data.settings); rootPath = data.rootPath;
        }
        persistenceInvalid = false;
      });
    },
    selectRoot(directory) { return operation(async () => { const selected = await checkedRoot(directory); await persist(selected); rootPath = selected; }); },
    setSettings(value) {
      const validated = validateSettings(value);
      return operation(async () => {
        await inspect();
        await persist(rootPath, validated); settings = validated;
        if (current.installed) await atomic(path.join(rootPath, CONFIG), encodeSettings(settings));
      });
    },
    install() {
      return operation(async () => {
        if (persistenceInvalid) throw safe('Le fichier de réglages invalide doit être récupéré avant l’installation.');
        if (platform !== 'win32' || !rootPath) throw safe('Choisissez une installation Windows de Clone Hero.');
        await checkedRoot(rootPath); await requireClosed();
        const moduleBytes = await regular(nativeBinaryPath);
        if (!moduleBytes?.length) throw safe('Le module graphique compilé n’est pas disponible dans cette version de ChartsHub.');
        const existingManifest = parseManifest(await regular(path.join(rootPath, MANIFEST), 16384));
        const currentDll = await regular(path.join(rootPath, 'dxgi.dll'));
        if (existingManifest && existingManifest.phase !== 'restored') throw safe('Un module ou une sauvegarde est déjà présent. Restaurez-le avant une nouvelle installation.');
        if (await regular(path.join(rootPath, 'd3d11.dll'))) throw safe('Un autre module Direct3D 11 est présent. Restaurez une installation sans ce module avant de continuer.');
        const originals = { 'dxgi.dll': currentDll, [CONFIG]: await regular(path.join(rootPath, CONFIG), 16384), [STATUS]: await regular(path.join(rootPath, STATUS), 8192) };
        const manifest = { version: 1, phase: 'prepared', moduleHash: hash(moduleBytes), backup: 'ChartsHubFilters-backup-' + randomUUID(), originals: Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, bytes === null ? null : hash(bytes)])) };
        const backup = path.join(rootPath, manifest.backup);
        await fs.mkdir(backup);
        for (const [name, bytes] of Object.entries(originals)) if (bytes !== null) await fs.writeFile(path.join(backup, name), bytes, { flag: 'wx' });
        await atomic(path.join(rootPath, MANIFEST), JSON.stringify(manifest, null, 2));
        await requireClosed();
        // A changed proxy must never be overwritten after the backup was made.
        const recheck = await regular(path.join(rootPath, 'dxgi.dll'));
        if ((recheck === null ? null : hash(recheck)) !== manifest.originals['dxgi.dll']) throw safe('Le module du jeu a changé pendant la préparation. Aucun remplacement effectué.');
        try {
          await atomic(path.join(rootPath, CONFIG), encodeSettings(settings));
          await atomic(path.join(rootPath, 'dxgi.dll'), moduleBytes);
          manifest.phase = 'installed'; await atomic(path.join(rootPath, MANIFEST), JSON.stringify(manifest, null, 2));
        } catch (error) {
          // The prepared manifest and verified backup remain available for recovery.
          throw error;
        }
      });
    },
    restore() {
      return operation(async () => {
        if (!rootPath || platform !== 'win32') throw safe('Choisissez une installation Windows de Clone Hero.');
        await checkedRoot(rootPath); await requireClosed();
        const manifest = parseManifest(await regular(path.join(rootPath, MANIFEST), 16384));
        if (!manifest || manifest.phase === 'restored') throw safe('Aucune installation ChartsHub à restaurer.');
        const originals = await backupFiles(manifest);
        const dll = await regular(path.join(rootPath, 'dxgi.dll'));
        const currentHash = dll ? hash(dll) : null;
        if (currentHash !== manifest.moduleHash && currentHash !== manifest.originals['dxgi.dll']) throw safe('Le module graphique a été modifié depuis l’installation. Il est conservé ; restauration automatique interrompue.');
        await requireClosed();
        const recheckedDll = await regular(path.join(rootPath, 'dxgi.dll'));
        if ((recheckedDll ? hash(recheckedDll) : null) !== currentHash) throw safe('Le module graphique a changé pendant la restauration. Il est conservé.');
        for (const [name, bytes] of Object.entries(originals)) {
          if (bytes === null) { await regular(path.join(rootPath, name)); await fs.unlink(path.join(rootPath, name)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          else await atomic(path.join(rootPath, name), bytes);
        }
        manifest.phase = 'restored'; await atomic(path.join(rootPath, MANIFEST), JSON.stringify(manifest, null, 2));
      });
    },
    async refresh() {
      if (disposed || busy) return status();
      if (!refreshTask) {
        refreshTask = tail.then(async () => {
          if (disposed) return status();
          try { await inspect(); } catch (error) { current.state = 'error'; current.error = error.code === 'FILTERS_SAFE' ? error.message : 'L’installation de filtres ne peut pas être vérifiée.'; current.message = current.error; }
          publish(); return status();
        });
        tail = refreshTask.catch(() => {});
        void refreshTask.finally(() => { refreshTask = null; });
      }
      return refreshTask;
    },
    async dispose() { disposed = true; await tail; }
  };
}
module.exports = { createFiltersService, DEFAULTS, RANGES, validateSettings, encodeSettings, parseStatus };
