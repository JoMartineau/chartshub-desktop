export const DEFAULT_FILTER_SETTINGS = Object.freeze({ enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 });
export const FILTER_PRESETS = Object.freeze({
  neutral: Object.freeze({ saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 }),
  vivid: Object.freeze({ saturation: 1.25, contrast: 1.08, gamma: 1, exposure: 0, sharpness: .15, vignette: 0 }),
  soft: Object.freeze({ saturation: .9, contrast: .93, gamma: 1.05, exposure: .05, sharpness: 0, vignette: .08 }),
  contrast: Object.freeze({ saturation: 1.05, contrast: 1.2, gamma: 1, exposure: 0, sharpness: .2, vignette: .12 }),
});
export function matchingFilterPreset(settings) {
  return Object.entries(FILTER_PRESETS).find(([, preset]) => Object.entries(preset).every(([key, value]) => Math.abs(settings[key] - value) < .005))?.[0] ?? 'custom';
}
export function filterPresentation(status) {
  if (!status) return { label: 'Connexion…', message: 'Chargement du module de filtres.', active: false };
  if (status.state === 'error') return { label: 'À vérifier', message: status.error || status.message || 'Le module ne répond pas. Ouvrez les réglages pour consulter son état.', active: false };
  if (status.native?.ready && status.native.frames > 0) {
    if (status.settings?.enabled !== status.native.enabled) return { label: 'Transmission en cours', message: 'Le module répond ; la confirmation du changement d’activation est attendue.', active: false };
    return status.native.enabled
      ? { label: 'Filtres actifs dans le jeu', message: 'Le module ChartsHub confirme le traitement de l’image de Clone Hero.', active: true }
      : { label: 'Module prêt · filtres désactivés', message: 'Le module répond. Activez les filtres pour appliquer le style choisi.', active: false };
  }
  if (status.installed) return { label: 'Installé · effet non confirmé', message: status.message || 'Lancez ou redémarrez Clone Hero pour charger le module. Son installation seule ne confirme pas que les effets sont appliqués.', active: false };
  return { label: status.rootPath || status.state === 'not-installed' ? 'Module à installer' : 'À configurer', message: status.message || 'Choisissez le dossier du jeu, puis installez le module ChartsHub.', active: false };
}

export class FiltersControls {
  constructor({ root, command, mini = false, focusRoot = root }) {
    this.root = root;
    this.focusRoot = focusRoot;
    this.command = command;
    this.mini = mini;
    this.settings = { ...DEFAULT_FILTER_SETTINGS };
    this.snapshot = null;
    this.pendingSettings = null;
    this.saving = false;
    this.busy = false;
    this.disposed = false;
    this.focusRevision = 0;
    this.listeners = [];
    this.listen('#filters-enabled', 'change', event => this.changeSettings({ enabled: event.target.checked }));
    this.listen('#filters-preset', 'change', event => {
      const preset = FILTER_PRESETS[event.target.value];
      if (preset) this.changeSettings(preset);
    });
    this.listen('#filters-reset', 'click', () => this.changeSettings({ ...DEFAULT_FILTER_SETTINGS }));
    this.listen('#filters-widget', 'change', event => void this.act('filters.widget', { enabled: event.target.checked }));
    for (const [selector, name] of [['choose-root', 'chooseRoot'], ['install', 'install'], ['restore', 'restore'], ['refresh', 'refresh'], ['open-panel', 'openPanel']]) {
      this.listen(`#filters-${selector}`, 'click', () => void this.act(`filters.${name}`));
    }
    for (const key of Object.keys(FILTER_PRESETS.neutral)) {
      this.listen(`#filters-${key}`, 'input', event => {
        this.settings = { ...this.settings, [key]: Number(event.target.value) };
        this.renderValues();
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.changeSettings({}); }, 120);
      });
      this.listen(`#filters-${key}`, 'change', () => { clearTimeout(this.saveTimer); this.saveTimer = null; this.changeSettings({}); });
    }
  }
  node(selector) { return this.root.querySelector(selector); }
  listen(selector, event, handler) {
    const node = this.node(selector);
    if (!node) return;
    node.addEventListener(event, handler);
    this.listeners.push(() => node.removeEventListener(event, handler));
  }
  feedback(message = '') {
    const node = this.node('#filters-feedback');
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
  }
  async act(name, payload) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.feedback();
    this.render();
    try {
      const result = await this.command(name, payload);
      if (!result?.ok && !this.disposed) this.feedback(result?.error || 'Cette action n’a pas pu être effectuée. Réessayez.');
    } catch {
      if (!this.disposed) this.feedback('ChartsHub ne répond pas. Fermez puis rouvrez ce panneau.');
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }
  changeSettings(patch) {
    if (this.disposed || !this.snapshot?.filters) return;
    this.settings = { ...this.settings, ...patch };
    this.pendingSettings = { ...this.settings };
    this.renderValues();
    void this.saveSettings();
  }
  async saveSettings() {
    if (this.saving || this.disposed) return;
    this.saving = true;
    this.feedback();
    try {
      // Coalesce slider changes while a save is pending; never send concurrent full settings.
      while (this.pendingSettings && !this.disposed) {
        const settings = this.pendingSettings;
        this.pendingSettings = null;
        const result = await this.command('filters.settings', { settings });
        if (!result?.ok) {
          this.pendingSettings = null;
          this.feedback(result?.error || 'Les réglages n’ont pas pu être enregistrés. Réessayez.');
          break;
        }
      }
    } catch {
      this.pendingSettings = null;
      if (!this.disposed) this.feedback('Les réglages n’ont pas pu être enregistrés. Réessayez.');
    } finally {
      this.saving = false;
      if (!this.disposed) {
        if (!this.saveTimer && this.snapshot?.filters?.settings) this.settings = { ...this.snapshot.filters.settings };
        this.render();
      }
    }
  }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot;
    if (!this.saving && !this.saveTimer && snapshot.filters?.settings) this.settings = { ...snapshot.filters.settings };
    this.render();
    if (!this.mini && snapshot.filtersFocusRevision > this.focusRevision) {
      this.focusRevision = snapshot.filtersFocusRevision;
      this.focusRoot.scrollIntoView({ block: 'start', behavior: 'smooth' });
      this.focusRoot.focus({ preventScroll: true });
    }
  }
  renderValues() {
    const toggle = this.node('#filters-enabled');
    if (toggle) toggle.checked = this.settings.enabled;
    const preset = this.node('#filters-preset');
    if (preset) preset.value = matchingFilterPreset(this.settings);
    for (const key of Object.keys(FILTER_PRESETS.neutral)) {
      const input = this.node(`#filters-${key}`), output = this.node(`#filters-${key}-value`);
      if (input) input.value = this.settings[key];
      if (output) output.textContent = ['sharpness', 'vignette'].includes(key) ? `${Math.round(this.settings[key] * 100)} %` : `${this.settings[key].toLocaleString(document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${key === 'exposure' ? ' EV' : ''}`;
    }
  }
  render() {
    const status = this.snapshot?.filters;
    const busy = this.busy || status?.busy;
    const presentation = filterPresentation(status);
    const badge = this.node('#filters-status');
    badge.textContent = presentation.label;
    badge.classList.toggle('is-visible', presentation.active);
    const message = this.node('#filters-message');
    if (message) message.textContent = presentation.message;
    for (const element of this.root.querySelectorAll('button, input, select')) element.disabled = !status || !!busy;
    if (!this.mini) {
      this.node('#filters-root').textContent = status?.rootPath || 'Aucun dossier sélectionné';
      this.node('#filters-install').disabled = !status?.rootPath || !status.supported || !status.binaryAvailable || !!status.installed || !!status.restoreAvailable || !!status.running || !!busy;
      this.node('#filters-install').textContent = status?.installed ? 'Module installé' : 'Installer le module';
      this.node('#filters-restore').disabled = !(status?.installed || status?.restoreAvailable) || !!status.running || !!busy;
      this.node('#filters-widget').checked = !!this.snapshot?.filtersWidgetEnabled;
      this.node('#filters-install-note').textContent = status?.running
        ? 'Fermez Clone Hero pour installer ou restaurer le module. Les réglages restent modifiables pendant le jeu.'
        : status?.rootPath && !status.binaryAvailable
          ? 'Le module natif est absent de cette version de ChartsHub. L’installation est indisponible.'
          : status?.reshadePresent
            ? 'ReShade a été détecté. Son module sera sauvegardé avant l’installation de ChartsHub ; vous pourrez le restaurer ici.'
            : 'Le module s’installe lorsque le jeu est fermé. Il sera chargé au prochain lancement de Clone Hero.';
    }
    this.renderValues();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.pendingSettings = null;
    this.listeners.splice(0).forEach(remove => remove());
  }
}
