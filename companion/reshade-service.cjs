'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { createCloneHeroProcessProbe } = require('./clonehero-process.cjs');

const ADDON = 'ChartsHubReShade.addon64', MANIFEST = 'ChartsHubReShade.install.json';
const MAX_REPLY = 4 * 1024 * 1024;
const safe = message => Object.assign(Error(message), { code: 'RESHADE_SAFE' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const plain = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
const text = (value, max = 512) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, max) : '';
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function regular(file, max = 32 * 1024 * 1024) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw safe('Un fichier ReShade est invalide ou a été remplacé.');
  return fs.readFile(file);
}
async function atomic(file, bytes) {
  await regular(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function checkedRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw safe('Choisissez le dossier contenant Clone Hero.exe.');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safe('Choisissez le dossier réel de Clone Hero.');
  const root = await fs.realpath(directory);
  const exe = await regular(path.join(root, 'Clone Hero.exe'), 128 * 1024 * 1024);
  if (!exe || exe.length < 64 || exe.toString('ascii', 0, 2) !== 'MZ') throw safe('Clone Hero.exe est absent de ce dossier.');
  const offset = exe.readUInt32LE(0x3c);
  if (offset + 6 > exe.length || exe.toString('ascii', offset, offset + 4) !== 'PE\0\0' || exe.readUInt16LE(offset + 4) !== 0x8664) throw safe('Le pont ReShade nécessite Clone Hero Windows 64 bits.');
  const unity = await fs.lstat(path.join(root, 'UnityPlayer.dll')).catch(() => null);
  if (!unity?.isFile() || unity.isSymbolicLink()) throw safe('UnityPlayer.dll est absent du dossier choisi.');
  return root;
}
function parseManifest(bytes) {
  if (!bytes) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw safe('Le journal du pont ReShade est illisible.'); }
  if (!object(value) || value.version !== 1 || !['prepared', 'installed'].includes(value.phase) || !/^[a-f0-9]{64}$/.test(value.moduleHash) || (value.previousHash !== undefined && value.previousHash !== null && !/^[a-f0-9]{64}$/.test(value.previousHash))) throw safe('Le journal du pont ReShade est invalide.');
  return value;
}

/** One bounded request per connection. The native server accepts only local clients of the same Windows user. */
function pipeRequest(pid, request, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return reject(safe('Session de jeu invalide.'));
    let settled = false, size = 0, chunks = [];
    const socket = net.createConnection('\\\\.\\pipe\\ChartsHub-ReShade-' + pid);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeout, () => finish(safe('ReShade ne répond pas. Revenez dans le jeu puis réessayez.')));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(safe('La connexion ReShade a été fermée.')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', bytes => {
      size += bytes.length;
      if (size > MAX_REPLY) return finish(safe('La réponse ReShade dépasse la taille autorisée.'));
      chunks.push(bytes);
      if (!bytes.includes(10)) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (!object(value) || value.id !== request.id || typeof value.ok !== 'boolean') throw Error('Invalid response');
        if (!value.ok) return finish(safe(text(value.error?.message, 240) || 'ReShade a refusé cette action.'));
        if (!object(value.data)) throw Error('Invalid response');
        finish(null, value.data);
      } catch { finish(safe('La réponse du pont ReShade est invalide.')); }
    });
  });
}
function validateCommand(value) {
  if (!object(value) || typeof value.action !== 'string') throw safe('Commande ReShade invalide.');
  const keys = Object.keys(value).sort().join(',');
  if (value.action === 'save' && keys === 'action') return { action: 'save' };
  if (value.action === 'enabled' && keys === 'action,enabled' && typeof value.enabled === 'boolean') return { ...value };
  if (value.action === 'technique' && keys === 'action,enabled,id' && validId(value.id) && typeof value.enabled === 'boolean') return { ...value };
  if (value.action === 'selectEffect' && keys === 'action,effect' && plain(value.effect) && value.effect.length) return { ...value };
  if (value.action === 'uniform' && keys === 'action,id,values' && validId(value.id) && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 16 && value.values.every(item => typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12))) return { ...value, values: [...value.values] };
  throw safe('Commande ReShade invalide.');
}
function metadataList(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(item => typeof item === 'number' && Number.isFinite(item)) ? value : null;
}
function normalizeUniform(item, effect) {
  if (!object(item) || !validId(item.id) || item.effect !== effect || !['float', 'int', 'uint', 'bool'].includes(item.type) || !Array.isArray(item.value) || item.value.length > 16 || !item.value.every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) throw safe('Paramètres ReShade invalides.');
  return { id: item.id, name: text(item.name), effect, label: text(item.label) || text(item.name), type: item.type,
    values: item.value, min: metadataList(item.min), max: metadataList(item.max), step: metadataList(item.step),
    items: Array.isArray(item.items) ? item.items.slice(0, 512).map(value => text(value)) : [], uiType: text(item.uiType, 64),
    description: text(item.tooltip, 2000), readOnly: item.readOnly === true || item.value.length === 0,
    components: item.components, rows: item.rows, columns: item.columns, arrayLength: item.arrayLength };
}

function createReShadeService({ dataDirectory, onChange = () => {}, initialRoot = null, filtersService = null,
  addonBinaryPath = path.join(__dirname, '..', 'reshade-bridge', 'bin', ADDON), platform = process.platform,
  probeGame, probeClosed, transport = pipeRequest } = {}) {
  const profile = path.join(dataDirectory, 'reshade.json');
  const processProbe = probeGame || createCloneHeroProcessProbe();
  let rootPath = initialRoot, busy = false, disposed = false, invalidProfile = false, tail = Promise.resolve(), refreshTask = null, requestId = 0, pid = null, generation = null;
  let current = { supported: platform === 'win32', installed: false, binaryAvailable: false, restoreAvailable: false, running: null, connected: false, state: 'unconfigured', message: 'Choisissez le dossier de Clone Hero.', error: null, catalog: null };
  // Other services publish host snapshots while inspection awaits disk or the
  // render thread. Expose only a completed check, never its provisional resets.
  let confirmed = structuredClone({ ...current, rootPath });
  const status = () => structuredClone({ ...confirmed, busy });
  const publish = ({ commit = true } = {}) => {
    if (commit) confirmed = structuredClone({ ...current, rootPath });
    if (!disposed) onChange(status());
  };
  async function persist(root = rootPath) {
    if (invalidProfile) throw safe('Le fichier reshade.json invalide est conservé. Récupérez-le avant de modifier cette configuration.');
    await fs.mkdir(dataDirectory, { recursive: true });
    await atomic(profile, JSON.stringify({ version: 1, rootPath: root }, null, 2) + '\n');
  }
  async function requireClosed() {
    // Use a fresh probe for file mutations; a cached running=false is not sufficient.
    const probe = await (probeClosed || probeGame || createCloneHeroProcessProbe())();
    if (probe.running !== false) throw safe(probe.running ? 'Fermez Clone Hero avant de connecter ReShade à ChartsHub.' : 'La fermeture de Clone Hero ne peut pas être vérifiée. Réessayez.');
  }
  async function wire(target, action) {
    const data = await transport(target, { id: ++requestId, ...action });
    if (!object(data) || data.protocol !== 1 || data.pid !== target || !samePath(data.executablePath, path.join(rootPath, 'Clone Hero.exe'))) throw safe('Ce pont ReShade appartient à une autre installation du jeu.');
    if (!Number.isSafeInteger(data.generation) || data.generation < 1 || typeof data.runtimeReady !== 'boolean' || typeof data.effectsEnabled !== 'boolean') throw safe('La réponse du pont ReShade est invalide.');
    return data;
  }
  async function readUniforms(effect) {
    const data = await wire(pid, { action: 'uniforms', effect });
    if (data.generation !== generation || data.runtimeReady !== true || data.effect !== effect || !Array.isArray(data.uniforms) || data.uniforms.length > 4096) throw safe('Les effets ont été rechargés. Sélectionnez de nouveau l’effet.');
    const uniforms = data.uniforms.map(item => normalizeUniform(item, effect));
    current.catalog.selectedEffect = effect;
    current.catalog.uniforms = uniforms;
  }
  function acceptCatalog(data) {
    if (!Array.isArray(data.techniques) || data.techniques.length > 10000 || typeof data.effectsEnabled !== 'boolean') throw safe('La liste des effets ReShade est invalide.');
    const techniques = data.techniques.map(item => {
      if (!object(item) || !validId(item.id) || !plain(item.effect) || !item.effect || typeof item.enabled !== 'boolean') throw safe('Effet ReShade invalide.');
      return { id: item.id, name: text(item.name), label: text(item.label) || text(item.name), effect: item.effect, enabled: item.enabled };
    });
    const previous = current.catalog;
    const selectedEffect = previous?.selectedEffect && techniques.some(item => item.effect === previous.selectedEffect) ? previous.selectedEffect : null;
    current.catalog = { enabled: data.effectsEnabled, preset: text(data.presetName), techniques, selectedEffect,
      uniforms: generation === data.generation && selectedEffect ? previous.uniforms : [] };
    generation = data.generation;
    current.connected = data.runtimeReady === true;
    current.state = current.connected ? 'ready' : 'loading';
    current.message = current.connected ? 'ReShade connecté. Choisissez les effets à activer.' : 'ReShade charge les effets du jeu.';
  }
  async function inspect({ parameters = true } = {}) {
    if (invalidProfile) return;
    const previousPid = pid;
    current.error = null; current.connected = false; pid = null;
    let bundle = null;
    try { bundle = await regular(addonBinaryPath); } catch { /* Missing build stays unavailable. */ }
    current.binaryAvailable = Boolean(bundle?.length); current.installed = false; current.restoreAvailable = false;
    if (platform !== 'win32' || !rootPath) { current.catalog = null; current.state = 'unconfigured'; current.message = platform === 'win32' ? 'Choisissez le dossier de Clone Hero.' : 'Le pont ReShade est disponible sur Windows 64 bits.'; return; }
    await checkedRoot(rootPath);
    const [addon, journal, proxy, ini, legacyBytes] = await Promise.all([
      regular(path.join(rootPath, ADDON)), regular(path.join(rootPath, MANIFEST), 16384), regular(path.join(rootPath, 'dxgi.dll')),
      regular(path.join(rootPath, 'ReShade.ini'), 1024 * 1024), regular(path.join(rootPath, 'ChartsHubFilters.install.json'), 16384)
    ]);
    const manifest = parseManifest(journal);
    current.installed = Boolean(addon && manifest && hash(addon) === manifest.moduleHash);
    const proxyIsReShade = Boolean(ini && proxy?.includes(Buffer.from('ReShadeRegisterAddon')));
    if (legacyBytes) {
      try { const legacy = JSON.parse(legacyBytes.toString('utf8')); current.restoreAvailable = legacy.phase !== 'restored' && legacy.originals?.['dxgi.dll'] !== null; } catch { /* Existing service validates the full journal before restoration. */ }
    }
    const probe = await processProbe(); current.running = probe.running;
    if (!current.installed || !proxyIsReShade) {
      current.catalog = null; generation = null; current.state = 'not-installed';
      current.message = current.restoreAvailable ? 'Connectez ChartsHub pour rétablir ReShade et retrouver ses effets.' : proxyIsReShade ? 'ReShade est présent. Installez le pont pour le piloter depuis ChartsHub.' : 'ReShade avec prise en charge des add-ons est requis dans ce dossier.';
      return;
    }
    if (probe.running === true) {
      for (const session of probe.sessions.slice(0, 16)) {
        try {
          const data = await wire(session.pid, { action: 'catalog' });
          if (previousPid !== session.pid) { current.catalog = null; generation = null; }
          pid = session.pid; acceptCatalog(data);
          if (parameters && current.catalog.selectedEffect && current.connected) await readUniforms(current.catalog.selectedEffect);
          return;
        } catch { pid = null; current.connected = false; }
      }
    }
    current.catalog = null; generation = null; current.state = 'restart-required';
    current.message = probe.running === true ? 'Pont installé, en attente de ReShade. Le chargement des shaders peut prendre quelques secondes.' : 'Pont installé. Lancez Clone Hero pour afficher ses effets ReShade.';
  }
  function operation(action) {
    const task = tail.then(async () => {
      if (disposed) throw safe('Le panneau ReShade est fermé.');
      busy = true; publish({ commit: false });
      try { return await action(); }
      catch (error) { current.error = error.code === 'RESHADE_SAFE' || error.code === 'FILTERS_SAFE' ? error.message : 'L’action ReShade a échoué. Vérifiez le dossier du jeu et sa connexion.'; current.message = current.error; throw safe(current.error); }
      finally { busy = false; publish(); }
    });
    tail = task.catch(() => {}); return task;
  }
  return {
    status,
    load() { return operation(async () => {
      invalidProfile = true;
      const bytes = await regular(profile, 16384);
      if (bytes) {
        let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw safe('Les réglages ReShade sont illisibles. Le fichier original est conservé.'); }
        if (!object(value) || value.version !== 1 || (value.rootPath !== null && (typeof value.rootPath !== 'string' || !path.isAbsolute(value.rootPath)))) throw safe('Les réglages ReShade sont invalides.');
        rootPath = value.rootPath;
      }
      invalidProfile = false; await inspect();
    }); },
    selectRoot(directory) { return operation(async () => {
      const selected = await checkedRoot(directory); await persist(selected); rootPath = selected;
      current.catalog = null; pid = null; generation = null; await inspect();
    }); },
    install() { return operation(async () => {
      if (invalidProfile || platform !== 'win32' || !rootPath) throw safe('Choisissez une installation Windows valide de Clone Hero.');
      await checkedRoot(rootPath); await requireClosed();
      const bytes = await regular(addonBinaryPath);
      if (!bytes?.length || bytes.toString('ascii', 0, 2) !== 'MZ') throw safe('Le pont ReShade compilé est absent de cette version.');
      const existing = await regular(path.join(rootPath, ADDON));
      const manifest = parseManifest(await regular(path.join(rootPath, MANIFEST), 16384));
      if (existing && (!manifest || (hash(existing) !== manifest.moduleHash && !(manifest.phase === 'prepared' && hash(existing) === manifest.previousHash)))) throw safe('Un autre pont ReShade est déjà présent. Il est conservé.');
      let proxy = await regular(path.join(rootPath, 'dxgi.dll'));
      if (!proxy?.includes(Buffer.from('ReShadeRegisterAddon'))) {
        if (!filtersService) throw safe('Restaurez d’abord votre installation ReShade depuis les filtres ChartsHub.');
        const legacyBytes = await regular(path.join(rootPath, 'ChartsHubFilters.install.json'), 16384);
        let legacy; try { legacy = JSON.parse(legacyBytes?.toString('utf8') || 'null'); } catch { throw safe('La sauvegarde du module précédent est illisible.'); }
        if (!legacy || !/^ChartsHubFilters-backup-[a-f0-9-]{36}$/.test(legacy.backup) || !/^[a-f0-9]{64}$/.test(legacy.originals?.['dxgi.dll'])) throw safe('Aucune sauvegarde ReShade vérifiable n’est disponible.');
        const backupDirectory = path.join(rootPath, legacy.backup), backupStat = await fs.lstat(backupDirectory);
        if (!backupStat.isDirectory() || backupStat.isSymbolicLink() || path.dirname(await fs.realpath(backupDirectory)) !== rootPath) throw safe('La sauvegarde ReShade a été déplacée ou remplacée.');
        const original = await regular(path.join(backupDirectory, 'dxgi.dll'));
        if (!original?.includes(Buffer.from('ReShadeRegisterAddon')) || hash(original) !== legacy.originals['dxgi.dll']) throw safe('La sauvegarde précédente ne contient pas un moteur ReShade vérifié.');
        if (!samePath(filtersService.status().rootPath, rootPath)) await filtersService.selectRoot(rootPath);
        await filtersService.refresh();
        if (!filtersService.status().restoreAvailable) throw safe('Aucune sauvegarde ReShade n’est disponible dans ce dossier.');
        // The existing installer validates the original backup and current proxy before restoring either.
        await filtersService.restore();
        proxy = await regular(path.join(rootPath, 'dxgi.dll'));
      }
      if (!proxy?.includes(Buffer.from('ReShadeRegisterAddon')) || !await regular(path.join(rootPath, 'ReShade.ini'), 1024 * 1024)) throw safe('ReShade avec prise en charge des add-ons est requis.');
      await persist();
      await requireClosed();
      const recheck = await regular(path.join(rootPath, ADDON));
      if ((recheck ? hash(recheck) : null) !== (existing ? hash(existing) : null)) throw safe('Le pont du jeu a changé pendant la préparation. Aucun remplacement effectué.');
      const proxyRecheck = await regular(path.join(rootPath, 'dxgi.dll'));
      if (!proxyRecheck || hash(proxyRecheck) !== hash(proxy)) throw safe('Le moteur graphique a changé pendant la préparation. Le pont n’a pas été installé.');
      const next = { version: 1, phase: 'prepared', moduleHash: hash(bytes), previousHash: existing ? hash(existing) : null };
      await atomic(path.join(rootPath, MANIFEST), JSON.stringify(next, null, 2));
      await atomic(path.join(rootPath, ADDON), bytes);
      next.phase = 'installed'; await atomic(path.join(rootPath, MANIFEST), JSON.stringify(next, null, 2));
      await inspect();
    }); },
    command(value) {
      const command = validateCommand(value);
      return operation(async () => {
        if (!pid || !current.connected || !current.catalog) throw safe('Lancez Clone Hero et attendez la connexion ReShade.');
        if (command.action === 'selectEffect') {
          if (!current.catalog.techniques.some(item => item.effect === command.effect)) throw safe('Cet effet n’est plus disponible. Actualisez la liste.');
          await readUniforms(command.effect); return;
        }
        let action;
        if (command.action === 'enabled') action = { action: 'setEnabled', enabled: command.enabled };
        if (command.action === 'technique') {
          if (!current.catalog.techniques.some(item => item.id === command.id)) throw safe('Cet effet a été rechargé. Actualisez la liste.');
          action = { action: 'setTechnique', techniqueId: command.id, enabled: command.enabled };
        }
        if (command.action === 'uniform') {
          const item = current.catalog.uniforms.find(item => item.id === command.id);
          if (!item || item.readOnly || item.values.length !== command.values.length) throw safe('Ce paramètre n’est plus modifiable. Sélectionnez de nouveau l’effet.');
          for (let i = 0; i < command.values.length; i++) {
            const value = command.values[i];
            if (item.type === 'bool' ? typeof value !== 'boolean' : typeof value !== 'number' || ((item.type === 'int' || item.type === 'uint') && !Number.isInteger(value)) || (item.type === 'uint' && value < 0)) throw safe('Valeur incompatible avec ce paramètre.');
            const minimum = item.min?.[i] ?? item.min?.[0], maximum = item.max?.[i] ?? item.max?.[0];
            if (typeof value === 'number' && ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum))) throw safe('Valeur hors des limites de cet effet.');
          }
          action = { action: 'setUniform', uniformId: command.id, value: command.values };
        }
        if (command.action === 'save') action = { action: 'savePreset' };
        const response = await wire(pid, action);
        // Enabling a technique may compile it and reload effects. A successful
        // command was applied: refresh its new IDs instead of reporting failure
        // or replaying the mutation against the new generation.
        if (response.generation !== generation) { generation = null; current.catalog.uniforms = []; }
        await inspect();
      });
    },
    refresh() {
      if (disposed || busy) return Promise.resolve(status());
      if (!refreshTask) {
        const task = tail.then(async () => {
          if (disposed) return status();
          try { await inspect(); } catch (error) { current.connected = false; current.catalog = null; current.state = 'error'; current.error = error.code === 'RESHADE_SAFE' ? error.message : 'La connexion ReShade ne peut pas être vérifiée.'; current.message = current.error; }
          publish(); return status();
        });
        refreshTask = task; tail = task.catch(() => {});
        void task.finally(() => { if (refreshTask === task) refreshTask = null; });
      }
      return refreshTask;
    },
    async dispose() { disposed = true; await tail; }
  };
}
module.exports = { createReShadeService, validateCommand, pipeRequest, normalizeUniform };
