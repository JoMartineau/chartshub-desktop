import * as model from './ui-bloom-model.js';

// All preview changes stay in this renderer. Only Apply invokes the native store.
const bridge = window.ChartsHubUIBloom;
const host = document.querySelector('#companion-app > .app-header');
if (bridge && host && !document.getElementById('ch-bloom-dialog')) {
  let saved = model.normalize(), draft = { ...saved }, busy = false, loaded = false, message = 'loading';
  const labels = [], controls = {}, swatches = [];
  const messages = {
    loading: ['Loading saved appearance…', 'Chargement de l’apparence enregistrée…'],
    preview: ['Live preview. Apply saves; Cancel or Escape restores the saved appearance.', 'Aperçu immédiat. Appliquer enregistre ; Annuler ou Échap rétablit l’apparence enregistrée.'],
    saved: ['Saved on this computer, including after restarting the app.', 'Enregistré sur cet ordinateur, y compris après redémarrage de l’application.'],
    saving: ['Saving…', 'Enregistrement…'],
    invalid: ['Previous settings are invalid. Defaults are shown; the file is unchanged until you Apply.', 'Les anciens réglages sont invalides. Les valeurs par défaut sont affichées ; le fichier reste inchangé jusqu’à Appliquer.'],
    loadError: ['Settings could not be read. Close and reopen this panel to retry; nothing was overwritten.', 'Lecture des réglages impossible. Fermez puis rouvrez ce panneau pour réessayer ; rien n’a été écrasé.'],
    saveError: ['Not saved. Your preview is kept; retry Apply or Cancel to restore the saved appearance.', 'Non enregistré. Votre aperçu est conservé ; réessayez Appliquer ou Annuler pour rétablir l’apparence enregistrée.']
  };
  const fr = () => document.documentElement.lang.toLowerCase().startsWith('fr');
  function node(tag, cls = '', en = '', french = en) {
    const el = document.createElement(tag); if (cls) el.className = cls;
    if (en) { labels.push({ el, en, fr: french }); el.textContent = fr() ? french : en; }
    return el;
  }
  function button(id, en, french) { const el = node('button', 'ch-bloom-button', en, french); el.id = 'ch-bloom-' + id; el.type = 'button'; return el; }
  const trigger = button('open', 'Theme', 'Thème');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'ch-bloom-dialog'); trigger.setAttribute('translate', 'no');
  host.append(trigger);
  const dialog = node('dialog', 'ch-bloom-dialog'); dialog.id = 'ch-bloom-dialog'; dialog.setAttribute('translate', 'no');
  dialog.setAttribute('aria-labelledby', 'ch-bloom-title'); dialog.setAttribute('aria-describedby', 'ch-bloom-info');
  const form = node('form', 'ch-bloom-form');
  const heading = node('div', 'ch-bloom-heading');
  const title = node('h2', '', 'Theme', 'Thème'); title.id = 'ch-bloom-title';
  const close = button('close', 'Close', 'Fermer'); heading.append(title, close); form.append(heading);
  const info = node('p', 'ch-bloom-muted', 'Decorative Companion panels only. No changes to notes, mini-widgets or ReShade. Local to this app profile, not synced with the website or your ChartsHub account.', 'Panneaux décoratifs du Companion uniquement. Aucun changement des notes, mini-widgets ou effets ReShade. Réglage local à ce profil de l’application, non synchronisé avec le site ou votre compte ChartsHub.');
  info.id = 'ch-bloom-info'; form.append(info);
  function field(name, type, en, french, parent = form) {
    const label = node('label', 'ch-bloom-field');
    const text = node('span', 'ch-bloom-label', en, french);
    const input = node('input'); input.id = 'ch-bloom-' + name; input.type = type;
    label.htmlFor = input.id; label.append(text, input); parent.append(label); controls[name] = input; return input;
  }
  function toggle(name, en, french) {
    const input = field(name, 'checkbox', en, french); input.parentElement.classList.add('ch-bloom-toggle');
    input.addEventListener('change', () => preview({ ...draft, [name]: input.checked })); return input;
  }
  toggle('enabled', 'Enable interface bloom', 'Activer le bloom de l’interface');
  const sample = node('div', 'ch-bloom-sample');
  sample.append(node('strong', '', 'ChartsHub / Companion'), node('span', '', 'Live preview · Text stays crisp', 'Aperçu immédiat · Le texte reste net')); form.append(sample);
  const colors = node('div', 'ch-bloom-color-row'); form.append(colors);
  const color = field('color', 'color', 'Bloom color', 'Couleur du bloom', colors);
  const hex = field('hex', 'text', 'HEX code', 'Code HEX', colors); hex.maxLength = 7; hex.required = true; hex.autocomplete = 'off'; hex.spellcheck = false;
  const rgb = node('div', 'ch-bloom-rgb'); form.append(rgb);
  for (const [i, key] of ['r', 'g', 'b'].entries()) {
    const input = field(key, 'number', ['Red (RGB)', 'Green (RGB)', 'Blue (RGB)'][i], ['Rouge (RVB)', 'Vert (RVB)', 'Bleu (RVB)'][i], rgb);
    input.min = '0'; input.max = '255'; input.step = '1'; input.required = true;
    input.addEventListener('input', () => {
      const values = ['r', 'g', 'b'].map(k => controls[k].valueAsNumber);
      ['r', 'g', 'b'].forEach((k, j) => valid(controls[k], Number.isInteger(values[j]) && values[j] >= 0 && values[j] <= 255));
      const value = model.fromRGB(values);
      if (value) { preview({ ...draft, color: value }); syncColors(); }
    });
  }
  color.addEventListener('input', () => { preview({ ...draft, color: color.value }); syncColors(); });
  hex.addEventListener('input', () => {
    const value = model.color(hex.value);
    if (valid(hex, Boolean(value))) { const typed = hex.value; preview({ ...draft, color: value }); syncColors(); hex.value = typed; }
  });
  hex.addEventListener('change', () => { if (hex.validity.valid) syncColors(); });
  const palette = node('div', 'ch-bloom-palette'); palette.setAttribute('role', 'group'); form.append(palette);
  for (const [value, en, french] of [['#a855f7','Violet','Violet'], ['#00cfff','Cyan','Cyan'], ['#38d96b','Green','Vert'], ['#ffbf36','Gold','Or'], ['#ff783c','Orange','Orange'], ['#f546c0','Pink','Rose']]) {
    const b = button('swatch-' + en.toLowerCase(), en, french); b.classList.add('ch-bloom-swatch'); b.dataset.color = value; b.style.setProperty('--swatch', value);
    b.addEventListener('click', () => { preview({ ...draft, color: value }); syncColors(); }); palette.append(b); swatches.push(b);
  }
  const names = { intensity: ['Intensity','Intensité'], radius: ['Spread radius','Rayon de diffusion'], blur: ['Blur','Flou'], opacity: ['Opacity','Opacité'] };
  for (const [key, [min, max, unit]] of Object.entries(model.RANGES)) {
    const input = field(key, 'range', ...names[key]); input.min = String(min); input.max = String(max); input.step = '1';
    const output = node('output', 'ch-bloom-value'); output.htmlFor = input.id; input.parentElement.append(output); controls[key + 'Value'] = output;
    input.addEventListener('input', () => { preview({ ...draft, [key]: input.valueAsNumber }); output.textContent = draft[key] + unit; });
  }
  toggle('economy', 'Economy mode (smaller, single halo)', 'Mode économique (halo unique et réduit)');
  const status = node('p', 'ch-bloom-status'); status.id = 'ch-bloom-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.append(status);
  const actions = node('div', 'ch-bloom-actions');
  const reset = button('reset', 'Reset', 'Réinitialiser'), cancel = button('cancel', 'Cancel', 'Annuler'), apply = button('apply', 'Apply', 'Appliquer');
  apply.type = 'submit'; apply.classList.add('ch-bloom-primary'); actions.append(reset, cancel, apply); form.append(actions);
  dialog.append(form); document.body.append(dialog);
  function translate() {
    for (const item of labels) item.el.textContent = fr() ? item.fr : item.en;
    palette.setAttribute('aria-label', fr() ? 'Couleurs rapides du bloom' : 'Quick bloom colors');
    status.textContent = messages[message]?.[fr() ? 1 : 0] || '';
  }
  function say(key) { message = key; translate(); }
  function valid(input, ok) { input.setCustomValidity(ok ? '' : (fr() ? 'Valeur invalide.' : 'Invalid value.')); input.setAttribute('aria-invalid', String(!ok)); return ok; }
  function paint(value) {
    const p = model.normalize(value);
    document.documentElement.style.setProperty('--ch-bloom-shadow', model.shadow(p));
    document.documentElement.dataset.chBloom = model.shadow(p) === 'none' ? 'off' : 'on';
    return p;
  }
  function preview(value) { if (busy) return; draft = paint(value); say('preview'); }
  function syncColors() {
    controls.color.value = draft.color; controls.hex.value = draft.color.toUpperCase(); valid(controls.hex, true);
    model.rgb(draft.color).forEach((v, i) => { controls[['r','g','b'][i]].value = v; valid(controls[['r','g','b'][i]], true); });
    for (const b of swatches) b.setAttribute('aria-pressed', String(b.dataset.color === draft.color));
  }
  function fill() {
    controls.enabled.checked = draft.enabled; controls.economy.checked = draft.economy;
    for (const [key, [, , unit]] of Object.entries(model.RANGES)) { controls[key].value = draft[key]; controls[key + 'Value'].textContent = draft[key] + unit; }
    syncColors();
  }
  function setBusy(value) {
    busy = value; form.setAttribute('aria-busy', String(value));
    for (const el of form.querySelectorAll('input, button')) el.disabled = value;
    apply.disabled = value || !loaded; trigger.disabled = value;
  }
  async function load() {
    setBusy(true); say('loading');
    try {
      const result = await bridge.read(), value = result?.ok && model.validate(result.settings);
      if (!value) throw Error('Unavailable');
      saved = value; draft = paint(saved); loaded = true; fill(); say(result.warning ? 'invalid' : 'preview');
    } catch { loaded = false; say('loadError'); }
    finally { setBusy(false); }
  }
  function open() {
    if (busy || dialog.open) return;
    draft = paint(saved); fill(); dialog.showModal(); void load();
  }
  trigger.addEventListener('click', open);
  for (const b of [close, cancel]) b.addEventListener('click', () => { if (!busy) dialog.close(); });
  reset.addEventListener('click', () => { preview(model.normalize()); fill(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { draft = paint(saved); fill(); trigger.focus(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !loaded || !form.reportValidity()) return;
    const candidate = model.validate(draft); if (!candidate) return;
    setBusy(true); say('saving');
    try {
      const result = await bridge.save(candidate), value = result?.ok && model.validate(result.settings);
      if (!value) throw Error('Not saved');
      saved = value; draft = paint(saved); fill(); say('saved');
    } catch { say('saveError'); }
    finally { setBusy(false); }
  });
  window.addEventListener('chartshub:languagechange', translate);
  new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  window.ChartshubBloom = Object.freeze({ open, read: () => ({ ...saved }) });
  paint(saved); fill(); translate(); void load();
}
