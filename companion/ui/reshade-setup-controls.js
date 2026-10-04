const stateLabels = { idle: 'À préparer', preparing: 'Téléchargement…', ready: 'Prêt à installer', installing: 'Installation…', complete: 'Installation terminée', error: 'À vérifier' };
const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
const size = value => `${(Math.max(0, value) / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;

export function setupPresentation(setup, source, includeStarterEffects) {
  const state = setup?.state || 'idle';
  const sameTarget = !!setup?.rootPath && setup.rootPath === source?.rootPath;
  const sameChoice = setup?.includeStarterEffects === includeStarterEffects;
  const reviewed = state === 'ready' && sameTarget && sameChoice && Array.isArray(setup?.files) && setup.files.length > 0;
  const canInstall = reviewed && source?.running === false && !setup?.busy;
  const alreadyInstalled = state === 'ready' && sameTarget && sameChoice && Array.isArray(setup?.files) && setup.files.length === 0;
  const note = state !== 'ready' ? '' : !sameTarget ? 'Le dossier a changé. Préparez de nouveau l’installation pour la nouvelle cible.' : !sameChoice ? 'Le choix du pack a changé. Préparez de nouveau le téléchargement.' : alreadyInstalled ? 'La version et les fichiers choisis sont déjà présents. Aucun fichier à installer.' : source?.running === true ? 'Fermez Clone Hero pour installer ces fichiers.' : source?.running !== false ? 'Actualisez l’état du jeu pour vérifier sa fermeture avant l’installation.' : 'Vérifiez le dossier et les fichiers, puis cliquez sur « Installer dans Clone Hero ».';
  return { label: alreadyInstalled ? 'Déjà installé' : stateLabels[state] || 'À vérifier', reviewed, canInstall, note };
}

export class ReShadeSetupControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null;
    this.includeStarterEffects = false; this.choiceInitialized = false; this.opened = false;
    this.pending = new Set(); this.listeners = []; this.disposed = false; this.fileSignature = ''; this.localError = ''; this.cancelRequested = false;
    this.listen('#reshade-setup-toggle', 'click', () => { this.opened = !this.opened; this.render(); });
    this.listen('#reshade-setup-effects', 'change', event => { this.includeStarterEffects = event.target.checked; this.choiceInitialized = true; this.render(); });
    this.listen('#reshade-setup-prepare', 'click', () => void this.act('reshade.setupPrepare', { includeStarterEffects: this.includeStarterEffects }));
    this.listen('#reshade-setup-install', 'click', () => void this.act('reshade.setupInstall'));
    this.listen('#reshade-setup-cancel', 'click', () => void this.act('reshade.setupCancel'));
  }
  node(selector) { return this.root.querySelector(selector); }
  listen(selector, event, handler) { const node = this.node(selector); node.addEventListener(event, handler); this.listeners.push(() => node.removeEventListener(event, handler)); }
  async act(name, payload) {
    if (this.disposed || this.pending.has(name)) return;
    if (name === 'reshade.setupPrepare') this.cancelRequested = false;
    if (name === 'reshade.setupCancel') this.cancelRequested = true;
    this.pending.add(name); this.localError = ''; this.render();
    try {
      const result = await this.command(name, payload);
      if (!this.disposed && !result?.ok && !(name === 'reshade.setupPrepare' && this.cancelRequested)) this.localError = result?.error || 'Cette étape n’a pas pu être terminée. Réessayez.';
    } catch { if (!this.disposed && !(name === 'reshade.setupPrepare' && this.cancelRequested)) this.localError = 'La connexion à ChartsHub est indisponible.'; }
    finally { this.pending.delete(name); if (!this.disposed) this.render(); }
  }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot;
    if (!this.choiceInitialized && snapshot.reshadeSetup) { this.includeStarterEffects = !!snapshot.reshadeSetup.includeStarterEffects; this.choiceInitialized = true; }
    this.render();
  }
  render() {
    const setup = this.snapshot?.reshadeSetup, source = this.snapshot?.reshade;
    const state = setup?.state || 'idle';
    const preparing = state === 'preparing' || this.pending.has('reshade.setupPrepare');
    const installing = state === 'installing' || this.pending.has('reshade.setupInstall');
    const busy = !!setup?.busy || preparing || installing;
    const visible = !source?.connected || this.opened || busy || ['ready', 'error'].includes(state);
    const presentation = setupPresentation(setup, source, this.includeStarterEffects);
    this.node('#reshade-setup').hidden = !visible;
    const toggle = this.node('#reshade-setup-toggle'); toggle.hidden = !source?.connected || busy || ['ready', 'error'].includes(state); toggle.setAttribute('aria-expanded', String(visible));
    setText(toggle, visible ? 'Masquer l’assistant' : 'Installer ou mettre à jour ReShade');
    setText(this.node('#reshade-setup-state'), installing ? 'Installation…' : preparing ? 'Téléchargement…' : presentation.label);
    this.node('#reshade-setup-effects').checked = this.includeStarterEffects;
    this.node('#reshade-setup-effects').disabled = !setup || busy;
    setText(this.node('#reshade-setup-message'), setup?.message || 'Choisissez le dossier du jeu ci-dessus pour commencer.');
    const progress = setup?.progress;
    this.node('#reshade-setup-progress').hidden = !progress;
    if (progress) {
      setText(this.node('#reshade-setup-progress-label'), progress.label || 'Téléchargement en cours');
      const received = typeof progress.received === 'number' && Number.isFinite(progress.received) ? Math.max(0, progress.received) : 0;
      const total = typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 0;
      setText(this.node('#reshade-setup-progress-size'), total ? `${size(received)} / ${size(total)}` : size(received));
      const meter = this.node('#reshade-setup-progress-meter');
      if (total) { meter.max = total; meter.value = Math.min(received, total); }
      else meter.removeAttribute('value');
    }
    const showReview = !!setup?.rootPath && (['ready', 'installing', 'complete'].includes(state) || !!setup?.files?.length);
    this.node('#reshade-setup-review').hidden = !showReview;
    setText(this.node('#reshade-setup-version'), `ReShade ${setup?.version || '—'}`);
    setText(this.node('#reshade-setup-root'), setup?.rootPath || 'Aucun dossier sélectionné');
    setText(this.node('#reshade-setup-ready-note'), state === 'complete' ? 'Relancez Clone Hero pour connecter ReShade et choisir vos effets.' : presentation.note);
    const files = setup?.files || [], signature = JSON.stringify(files);
    if (signature !== this.fileSignature) {
      this.fileSignature = signature;
      const fragment = this.root.ownerDocument.createDocumentFragment();
      for (const filename of files) { const item = this.root.ownerDocument.createElement('li'); item.textContent = filename; fragment.append(item); }
      this.node('#reshade-setup-files').replaceChildren(fragment);
    }
    const error = this.localError || setup?.error || '';
    this.node('#reshade-setup-error').hidden = !error; setText(this.node('#reshade-setup-error'), error);
    const prepare = this.node('#reshade-setup-prepare'); prepare.disabled = !setup || !source?.rootPath || !source.supported || busy || this.pending.has('reshade.setupCancel');
    setText(prepare, ['ready', 'error', 'complete'].includes(state) ? 'Préparer de nouveau' : 'Préparer le téléchargement');
    const install = this.node('#reshade-setup-install'); install.hidden = !['ready', 'installing'].includes(state); install.disabled = !presentation.canInstall || busy || this.pending.has('reshade.setupCancel');
    const cancel = this.node('#reshade-setup-cancel'); cancel.hidden = !preparing && state !== 'ready'; cancel.disabled = installing || this.pending.has('reshade.setupCancel');
  }
  dispose() { this.disposed = true; this.listeners.splice(0).forEach(remove => remove()); }
}
