export function reShadePresentation(status) {
  if (!status) return { label: 'Connexion…', message: 'Chargement de la connexion ReShade.', active: false };
  if (status.error || status.state === 'error') return { label: status.connected ? 'Action à vérifier' : 'Connexion à vérifier', message: status.error || status.message || 'Ouvrez les réglages pour vérifier la connexion ReShade.', active: false };
  if (status.connected && status.catalog) return { label: status.catalog.enabled ? 'ReShade connecté · effets activés' : 'ReShade connecté · effets désactivés', message: status.message || 'Les effets et paramètres ci-dessous proviennent de ReShade dans Clone Hero.', active: !!status.catalog.enabled };
  if (status.installed) return { label: 'Installé · en attente de ReShade', message: status.message || 'Relancez Clone Hero avec ReShade pour recevoir les effets. L’installation seule ne confirme pas la connexion.', active: false };
  return { label: 'ReShade à connecter', message: status.message || 'Choisissez votre dossier de Clone Hero, puis installez l’intégration ReShade lorsque le jeu est fermé.', active: false };
}

export function filterTechniques(techniques, query) {
  const needle = query.trim().toLocaleLowerCase('fr-FR');
  return techniques.filter(item => !needle || `${item.label || item.name} ${item.name} ${item.effect}`.toLocaleLowerCase('fr-FR').includes(needle));
}

function componentBound(values, index) {
  const value = Array.isArray(values) ? values[index] ?? values[0] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeUniformComponent(uniform, index, raw) {
  if (uniform.type === 'bool') return !!raw;
  let value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) return null;
  const min = componentBound(uniform.min, index), max = componentBound(uniform.max, index);
  if (uniform.type === 'int' || uniform.type === 'uint') value = Math.round(value);
  if (uniform.type === 'uint') value = Math.max(0, value);
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

export class ReShadeControls {
  constructor({ root, command, mini = false }) {
    this.root = root; this.command = command; this.mini = mini;
    this.snapshot = null; this.disposed = false; this.actionBusy = false; this.sending = false;
    this.listeners = []; this.pending = new Map(); this.drafts = new Map(); this.timers = new Map();
    this.uniformNodes = new Map(); this.techniqueNodes = new Map(); this.uniformSignature = ''; this.techniqueSignature = '';
    this.catalogIdentity = ''; this.catalogRevision = 0;
    this.listen('#reshade-search', 'input', () => this.renderTechniques(true));
    this.listen('#reshade-enabled', 'change', event => this.enqueue({ action: 'enabled', enabled: event.target.checked }));
    this.listen('#reshade-widget', 'change', event => void this.act('filters.widget', { enabled: event.target.checked }));
    for (const [selector, name] of [['choose-root', 'reshade.chooseRoot'], ['install', 'reshade.install'], ['refresh', 'reshade.refresh'], ['open-panel', 'filters.openPanel']]) this.listen(`#reshade-${selector}`, 'click', () => void this.act(name));
    this.listen('#reshade-save', 'click', () => this.enqueue({ action: 'save' }));
  }
  node(selector) { return this.root.querySelector(selector); }
  listen(selector, event, handler) {
    const node = this.node(selector); if (!node) return;
    node.addEventListener(event, handler); this.listeners.push(() => node.removeEventListener(event, handler));
  }
  feedback(message = '') {
    const node = this.node('#reshade-feedback');
    if (node) { node.textContent = message; node.hidden = !message; }
  }
  async act(name, payload) {
    if (this.disposed || this.actionBusy) return;
    this.actionBusy = true; this.feedback(); this.render();
    try {
      const result = await this.command(name, payload);
      if (!this.disposed && !result?.ok) this.feedback(result?.error || 'Cette action ReShade n’a pas pu être effectuée. Réessayez.');
    } catch { if (!this.disposed) this.feedback('La connexion à ChartsHub est indisponible.'); }
    finally { this.actionBusy = false; if (!this.disposed) this.render(); }
  }
  enqueue(payload) {
    if (this.disposed || !this.snapshot?.reshade?.connected) return;
    if (['save', 'selectEffect'].includes(payload.action)) {
      for (const [id, timer] of this.timers) {
        clearTimeout(timer);
        const values = this.drafts.get(id);
        if (values) this.pending.set('uniform:' + id, { action: 'uniform', id, values: [...values] });
      }
      this.timers.clear();
    }
    const key = payload.action + ':' + (payload.id || '');
    this.pending.set(key, payload);
    void this.drain();
  }
  async drain() {
    if (this.sending || this.disposed) return;
    this.sending = true; this.feedback();
    let requestRevision = this.catalogRevision;
    try {
      while (this.pending.size && !this.disposed) {
        const [key, payload] = this.pending.entries().next().value;
        this.pending.delete(key);
        const revision = this.catalogRevision; requestRevision = revision;
        const result = await this.command('reshade.command', payload);
        if (this.disposed) break;
        if (revision !== this.catalogRevision) continue;
        if (!this.disposed && !result?.ok) {
          this.pending.clear(); this.drafts.clear();
          this.feedback(result?.error || 'Le réglage n’a pas pu être transmis à ReShade. Réessayez.');
          break;
        }
        if (payload.action === 'uniform' && !this.pending.has(key) && !this.timers.has(payload.id)) this.drafts.delete(payload.id);
        if (payload.action === 'save' && !this.disposed) this.feedback('Demande d’enregistrement transmise à ReShade.');
      }
    } catch {
      if (requestRevision === this.catalogRevision) {
        this.pending.clear(); this.drafts.clear();
        if (!this.disposed) this.feedback('La connexion ReShade est indisponible. Les réglages ne sont pas confirmés.');
      }
    } finally { this.sending = false; if (!this.disposed) { this.render(); if (this.pending.size) void this.drain(); } }
  }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot;
    const catalog = snapshot?.reshade?.connected ? snapshot.reshade.catalog : null;
    const uniformIds = new Set((catalog?.uniforms ?? []).filter(item => !item.readOnly).map(item => item.id));
    const techniqueIds = new Set((catalog?.techniques ?? []).map(item => item.id));
    const effects = new Set((catalog?.techniques ?? []).map(item => item.effect));
    const identity = JSON.stringify([!!catalog, [...techniqueIds], catalog?.selectedEffect, [...uniformIds]]);
    if (identity !== this.catalogIdentity) { this.catalogIdentity = identity; this.catalogRevision++; }
    for (const [id, timer] of this.timers) if (!uniformIds.has(id)) { clearTimeout(timer); this.timers.delete(id); }
    for (const id of this.drafts.keys()) if (!uniformIds.has(id)) this.drafts.delete(id);
    for (const [key, payload] of this.pending) {
      if (!catalog || (payload.action === 'uniform' && !uniformIds.has(payload.id)) || (payload.action === 'technique' && !techniqueIds.has(payload.id)) || (payload.action === 'selectEffect' && !effects.has(payload.effect))) this.pending.delete(key);
    }
    this.render();
  }
  render() {
    const status = this.snapshot?.reshade;
    const connected = !!status?.connected && !!status?.catalog;
    const blocked = !connected || this.actionBusy;
    const presentation = reShadePresentation(status);
    this.node('#reshade-status').textContent = presentation.label;
    this.node('#reshade-status').classList.toggle('is-visible', presentation.active);
    if (this.node('#reshade-message')) this.node('#reshade-message').textContent = presentation.message;
    if (this.node('#reshade-root')) this.node('#reshade-root').textContent = status?.rootPath || 'Aucun dossier sélectionné';
    for (const selector of ['#reshade-enabled', '#reshade-save', '#reshade-search']) if (this.node(selector)) this.node(selector).disabled = blocked;
    const enabled = this.node('#reshade-enabled');
    enabled.checked = !!status?.catalog?.enabled;
    for (const selector of ['#reshade-choose-root', '#reshade-refresh']) if (this.node(selector)) this.node(selector).disabled = !status || !!status.busy || this.actionBusy || (selector === '#reshade-choose-root' && !!this.snapshot?.reshadeSetup?.busy);
    if (this.node('#reshade-install')) {
      this.node('#reshade-install').disabled = !status?.rootPath || !status.supported || !status.binaryAvailable || status.running !== false || !!status.busy || this.actionBusy || !!this.snapshot?.reshadeSetup?.busy;
      this.node('#reshade-install').textContent = status?.installed ? 'Réinstaller l’intégration' : 'Installer l’intégration ReShade';
    }
    if (this.node('#reshade-widget')) { this.node('#reshade-widget').checked = !!this.snapshot?.filtersWidgetEnabled; this.node('#reshade-widget').disabled = !status || this.actionBusy; }
    if (this.node('#reshade-open-panel')) this.node('#reshade-open-panel').disabled = !this.snapshot || this.actionBusy;
    if (this.node('#reshade-preset')) this.node('#reshade-preset').textContent = status?.catalog?.preset || 'En attente de ReShade';
    this.renderTechniques(); this.renderUniforms();
  }
  element(tag, className, text) {
    const node = this.root.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  renderTechniques(force = false) {
    const status = this.snapshot?.reshade, catalog = status?.catalog;
    const all = catalog?.techniques ?? [];
    const matches = filterTechniques(all, this.node('#reshade-search')?.value || '');
    const shown = matches.slice(0, this.mini ? 35 : 150);
    this.node('#reshade-count').textContent = !status?.connected ? 'Les effets apparaîtront à la connexion.' : `${matches.length} effet${matches.length === 1 ? '' : 's'}${shown.length < matches.length ? ` · ${shown.length} affichés, précisez la recherche` : ''}`;
    const signature = JSON.stringify(shown.map(item => [item.id, item.name, item.label, item.effect]));
    if (force || signature !== this.techniqueSignature) {
      this.techniqueSignature = signature; this.techniqueNodes.clear();
      const fragment = this.root.ownerDocument.createDocumentFragment();
      for (const item of shown) {
        const row = this.element('div', 'reshade-technique'); row.dataset.techniqueId = item.id;
        const label = this.element('label');
        const toggle = this.element('input'); toggle.type = 'checkbox'; toggle.setAttribute('aria-label', `Activer ${item.label || item.name}`);
        toggle.addEventListener('change', () => this.enqueue({ action: 'technique', id: item.id, enabled: toggle.checked }));
        const names = this.element('span', 'reshade-technique-name');
        names.append(this.element('strong', '', item.label || item.name), this.element('small', '', item.effect));
        label.append(toggle, names);
        const select = this.element('button', 'reshade-select-effect', 'Réglages'); select.type = 'button'; select.setAttribute('aria-label', `Réglages de ${item.label || item.name}`);
        select.addEventListener('click', () => this.enqueue({ action: 'selectEffect', effect: item.effect }));
        row.append(label, select); fragment.append(row);
        this.techniqueNodes.set(item.id, { row, toggle, select });
      }
      this.node('#reshade-techniques').replaceChildren(fragment);
    }
    for (const item of shown) {
      const nodes = this.techniqueNodes.get(item.id); if (!nodes) continue;
      nodes.toggle.checked = !!item.enabled;
      nodes.toggle.disabled = !status?.connected || this.actionBusy;
      nodes.select.disabled = !status?.connected || this.actionBusy;
      const selected = item.effect === catalog?.selectedEffect;
      nodes.select.setAttribute('aria-pressed', String(selected)); nodes.row.classList.toggle('is-selected', selected);
    }
  }
  renderUniforms() {
    const status = this.snapshot?.reshade, catalog = status?.catalog;
    const uniforms = (catalog?.uniforms ?? []).filter(uniform => !uniform.readOnly);
    this.node('#reshade-effect-title').textContent = catalog?.selectedEffect || 'Réglages de l’effet';
    this.node('#reshade-effect-hint').textContent = !status?.connected ? 'Connectez ReShade pour modifier les paramètres.' : !catalog?.selectedEffect ? 'Sélectionnez « Réglages » sur un effet.' : uniforms.length ? 'Les modifications sont transmises au jeu. Enregistrez le preset pour les conserver.' : 'Cet effet ne propose aucun paramètre modifiable.';
    const signature = JSON.stringify([catalog?.selectedEffect, uniforms.map(({ values, ...metadata }) => ({ ...metadata, count: values.length }))]);
    if (signature !== this.uniformSignature) {
      this.uniformSignature = signature; this.uniformNodes.clear();
      const fragment = this.root.ownerDocument.createDocumentFragment();
      for (const uniform of uniforms) {
        const group = this.element('fieldset', 'reshade-uniform'); group.dataset.uniformId = uniform.id;
        group.append(this.element('legend', '', uniform.label || uniform.name));
        if (uniform.description) group.append(this.element('p', 'helper-text', uniform.description));
        const controls = [];
        uniform.values.forEach((_value, index) => {
          const row = this.element('div', 'reshade-uniform-component');
          const label = uniform.values.length > 1 ? `${uniform.label || uniform.name} · ${index + 1}` : uniform.label || uniform.name;
          let control, range = null;
          const min = componentBound(uniform.min, index), max = componentBound(uniform.max, index), step = componentBound(uniform.step, index);
          if (uniform.type === 'bool') { control = this.element('input'); control.type = 'checkbox'; }
          else if (uniform.items?.length && ['int', 'uint'].includes(uniform.type)) {
            control = this.element('select');
            uniform.items.forEach((text, value) => { const option = this.element('option', '', text); option.value = String(value); control.append(option); });
          } else {
            control = this.element('input'); control.type = 'number';
            if (min !== undefined) control.min = String(min);
            if (max !== undefined) control.max = String(max);
            control.step = String(step && step > 0 ? step : uniform.type === 'float' ? 'any' : 1);
            if (min !== undefined && max !== undefined && max > min) {
              range = this.element('input'); range.type = 'range'; range.min = String(min); range.max = String(max); range.step = String(step && step > 0 ? step : uniform.type === 'float' ? Math.max((max - min) / 1000, .0001) : 1);
              range.setAttribute('aria-label', label); range.dataset.uniformId = uniform.id; range.dataset.component = String(index);
              range.addEventListener('input', () => this.editUniform(uniform.id, index, range.value, false));
              range.addEventListener('change', () => this.editUniform(uniform.id, index, range.value, true)); row.append(range);
            }
          }
          control.setAttribute('aria-label', label); control.dataset.uniformId = uniform.id; control.dataset.component = String(index);
          control.addEventListener('change', () => this.editUniform(uniform.id, index, uniform.type === 'bool' ? control.checked : control.value, true));
          row.append(control); group.append(row); controls.push({ control, range });
        });
        if (uniform.readOnly) group.append(this.element('p', 'helper-text', 'Paramètre fourni automatiquement par ReShade.'));
        this.uniformNodes.set(uniform.id, controls); fragment.append(group);
      }
      this.node('#reshade-uniforms').replaceChildren(fragment);
    }
    for (const uniform of uniforms) {
      const values = this.drafts.get(uniform.id) || uniform.values;
      this.uniformNodes.get(uniform.id)?.forEach(({ control, range }, index) => {
        const disabled = !status?.connected || this.actionBusy || !!uniform.readOnly;
        control.disabled = disabled;
        if (uniform.type === 'bool') control.checked = !!values[index];
        else if (control !== this.root.ownerDocument.activeElement) control.value = String(values[index]);
        if (range) { range.disabled = disabled; if (range !== this.root.ownerDocument.activeElement) range.value = String(values[index]); }
      });
    }
  }
  editUniform(id, index, raw, immediate) {
    const uniform = this.snapshot?.reshade?.catalog?.uniforms?.find(item => item.id === id);
    if (!uniform || uniform.readOnly || !this.snapshot.reshade.connected) return;
    const normalized = normalizeUniformComponent(uniform, index, raw);
    if (normalized === null) { this.feedback('Entrez une valeur numérique valide.'); return; }
    const values = [...(this.drafts.get(id) || uniform.values)]; values[index] = normalized; this.drafts.set(id, values);
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.renderUniforms();
    const send = () => { this.timers.delete(id); this.enqueue({ action: 'uniform', id, values: [...(this.drafts.get(id) || values)] }); };
    if (immediate) send(); else this.timers.set(id, setTimeout(send, 140));
  }
  dispose() {
    this.disposed = true; this.pending.clear(); this.drafts.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.listeners.splice(0).forEach(remove => remove());
  }
}
