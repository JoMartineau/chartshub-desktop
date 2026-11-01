// Main-panel controls only. OBS sharing never connects a chat provider or
// starts the listener until the user explicitly copies one of its URLs.
const DEFAULTS = Object.freeze({ shareChat: false, shareActivity: false, showViewerNames: false, fontSize: 18, maxItems: 6, accent: '#49bbff' });
const BOOLS = ['shareChat', 'shareActivity', 'showViewerNames'];
const TEXT = {
  fr: {
    title: 'Chat et activité · widgets OBS', intro: 'Ajoutez une source Navigateur dans OBS avec le lien de votre choix. Le partage est désactivé à chaque démarrage de ChartsHub.',
    shareChat: 'Partager le chat dans OBS', chatPrivacy: 'Autorise l’affichage des pseudos et des messages du chat connecté. Activer ce partage ne connecte pas votre chat.',
    shareActivity: 'Partager l’activité dans OBS', activityPrivacy: 'Affiche les nouvelles demandes et les téléchargements terminés de cette session. Les événements précédents sont ignorés.',
    showViewerNames: 'Afficher aussi les pseudos dans l’activité', fontSize: 'Taille du texte (px)', maxItems: 'Nombre de lignes', accent: 'Couleur',
    apply: 'Appliquer le partage et le style', reset: 'Recharger les réglages', copyChat: 'Copier le lien du chat OBS', copyActivity: 'Copier le lien de l’activité OBS',
    private: 'Aucun flux partagé.', shared: 'Partage OBS activé.', unsaved: 'Modifications non appliquées.', stale: 'Les réglages ont changé ailleurs. Rechargez-les avant d’appliquer.',
    busy: 'Action en cours…', copied: 'Lien copié. Collez-le dans une source Navigateur OBS.', saved: 'Réglages appliqués pour cette session.',
    error: 'Cette action n’a pas pu être terminée. Réessayez.', invalid: 'Choisissez une taille de 12 à 48 px et entre 1 et 20 lignes.',
    guide: 'Le lien reste local à cet ordinateur. Toute personne qui possède ce lien peut voir le flux tant que le partage est activé. Désactivez les deux partages pour masquer ces sources.',
  },
  en: {
    title: 'Chat and activity · OBS widgets', intro: 'Add a Browser source in OBS using the link you want. Sharing is off every time ChartsHub starts.',
    shareChat: 'Share chat in OBS', chatPrivacy: 'Allows connected chat messages and viewer names to appear. Enabling this sharing does not connect your chat.',
    shareActivity: 'Share activity in OBS', activityPrivacy: 'Shows new requests and completed downloads from this session. Earlier events are ignored.',
    showViewerNames: 'Also show viewer names in activity', fontSize: 'Text size (px)', maxItems: 'Number of rows', accent: 'Color',
    apply: 'Apply sharing and style', reset: 'Reload settings', copyChat: 'Copy OBS chat link', copyActivity: 'Copy OBS activity link',
    private: 'No feed is shared.', shared: 'OBS sharing enabled.', unsaved: 'Unapplied changes.', stale: 'Settings changed elsewhere. Reload them before applying.',
    busy: 'Action in progress…', copied: 'Link copied. Paste it into an OBS Browser source.', saved: 'Settings applied for this session.',
    error: 'This action could not be completed. Try again.', invalid: 'Choose a text size from 12 to 48 px and from 1 to 20 rows.',
    guide: 'The link stays local to this computer. Anyone with this link can view the feed while sharing is enabled. Disable both sharing options to hide these sources.',
  },
};
function settings(value) {
  if (!value || BOOLS.some(key => typeof value[key] !== 'boolean') || !Number.isSafeInteger(value.fontSize) || value.fontSize < 12 || value.fontSize > 48 || !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 20 || typeof value.accent !== 'string' || !/^#[a-f0-9]{6}$/i.test(value.accent)) return null;
  return { shareChat: value.shareChat, shareActivity: value.shareActivity, showViewerNames: value.showViewerNames, fontSize: value.fontSize, maxItems: value.maxItems, accent: value.accent.toLowerCase() };
}
export class SessionWidgetControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.signature = null; this.dirty = false; this.baseRevision = null; this.pending = false; this.message = ''; this.disposed = false; this.ticket = 0; this.listeners = [];
    const make = (tag, className = '') => { const node = root.ownerDocument.createElement(tag); node.className = className; return node; };
    const title = make('h3'), intro = make('p', 'helper-text'), fields = make('div', 'session-widget-fields'), actions = make('div', 'session-widget-actions'), guide = make('p', 'helper-text');
    const status = make('p', 'session-widget-status'); status.id = 'session-widgets-status'; status.setAttribute('role', 'status');
    const feedback = make('p', 'session-widget-feedback'); feedback.id = 'session-widgets-feedback'; feedback.setAttribute('role', 'status');
    this.nodes = { title, intro, fields, actions, guide, status, feedback };
    const ids = { shareChat: 'share-chat', shareActivity: 'share-activity', showViewerNames: 'show-viewer-names', fontSize: 'font-size', maxItems: 'max-items', accent: 'accent' };
    for (const [key, suffix] of Object.entries(ids)) {
      const label = make('label', BOOLS.includes(key) ? 'session-widget-toggle' : 'session-widget-field'), caption = make('span'), input = make('input');
      input.id = 'session-widgets-' + suffix; input.type = BOOLS.includes(key) ? 'checkbox' : key === 'accent' ? 'color' : 'number';
      if (key === 'fontSize') { input.min = '12'; input.max = '48'; input.step = '1'; }
      if (key === 'maxItems') { input.min = '1'; input.max = '20'; input.step = '1'; }
      label.append(input, caption); fields.append(label); this.nodes[key] = input; this.nodes[key + 'Label'] = caption;
      const listener = () => { if (this.disposed) return; if (!this.dirty) this.baseRevision = this.currentRevision(); this.dirty = true; this.message = ''; this.signature = null; this.update(this.snapshot); };
      input.addEventListener('input', listener); this.listeners.push([input, 'input', listener]);
      if (key === 'shareChat' || key === 'shareActivity') { const privacy = make('p', 'helper-text session-widget-privacy'); fields.append(privacy); this.nodes[key + 'Privacy'] = privacy; }
    }
    for (const action of ['apply', 'reset', 'copyChat', 'copyActivity']) {
      const button = make('button', 'button secondary'); button.type = 'button'; button.id = 'session-widgets-' + ({ copyChat: 'copy-chat', copyActivity: 'copy-activity' }[action] ?? action);
      const listener = () => { void this.run(action); }; button.addEventListener('click', listener); this.listeners.push([button, 'click', listener]); actions.append(button); this.nodes[action] = button;
    }
    root.replaceChildren(title, intro, fields, actions, status, feedback, guide); this.update({ language: 'fr', sessionWidgets: { revision: 0, settings: DEFAULTS } });
  }
  currentRevision() { return Number.isSafeInteger(this.snapshot?.sessionWidgets?.revision) && this.snapshot.sessionWidgets.revision >= 0 ? this.snapshot.sessionWidgets.revision : 0; }
  draft() { const n = this.nodes; return settings({ shareChat: n.shareChat.checked, shareActivity: n.shareActivity.checked, showViewerNames: n.showViewerNames.checked, fontSize: Number(n.fontSize.value), maxItems: Number(n.maxItems.value), accent: n.accent.value }); }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot; const language = snapshot?.language === 'en' ? 'en' : 'fr', state = snapshot?.sessionWidgets ?? {}, applied = settings(state.settings) ?? { ...DEFAULTS }, revision = this.currentRevision();
    const signature = JSON.stringify([language, applied, revision, state.error ?? null, this.pending, this.dirty, this.baseRevision, this.message]);
    if (signature === this.signature) return; this.signature = signature;
    const t = TEXT[language], n = this.nodes, stale = this.dirty && this.baseRevision !== revision;
    n.title.textContent = t.title; n.intro.textContent = t.intro; n.guide.textContent = t.guide;
    for (const key of Object.keys(DEFAULTS)) { n[key + 'Label'].textContent = t[key]; n[key].disabled = this.pending; if (!this.dirty) { if (BOOLS.includes(key)) n[key].checked = applied[key]; else n[key].value = String(applied[key]); } }
    n.shareChatPrivacy.textContent = t.chatPrivacy; n.shareActivityPrivacy.textContent = t.activityPrivacy;
    for (const action of ['apply', 'reset', 'copyChat', 'copyActivity']) n[action].textContent = t[action];
    n.apply.disabled = this.pending || !this.dirty || stale; n.reset.disabled = this.pending || !this.dirty;
    n.copyChat.disabled = this.pending || !applied.shareChat; n.copyActivity.disabled = this.pending || !applied.shareActivity;
    n.status.textContent = this.pending ? t.busy : stale ? t.stale : this.dirty ? t.unsaved : applied.shareChat || applied.shareActivity ? t.shared : t.private;
    n.feedback.textContent = this.message ? t[this.message] ?? t.error : state.error ? t.error : ''; n.feedback.hidden = !n.feedback.textContent;
    this.root.setAttribute('aria-busy', String(this.pending));
  }
  async run(action) {
    if (this.disposed || this.pending || !['apply', 'reset', 'copyChat', 'copyActivity'].includes(action) || this.nodes[action].disabled) return;
    if (action === 'reset') { this.dirty = false; this.baseRevision = null; this.message = ''; this.signature = null; this.update(this.snapshot); return; }
    const draft = action === 'apply' ? this.draft() : null;
    if (action === 'apply' && !draft) { this.message = 'invalid'; this.signature = null; this.update(this.snapshot); return; }
    const ticket = ++this.ticket; this.pending = true; this.message = ''; this.signature = null; this.update(this.snapshot);
    try {
      const result = await this.command(action === 'apply' ? 'sessionWidgets.configure' : 'sessionWidgets.copyUrl', action === 'apply' ? { revision: this.baseRevision, settings: draft } : { kind: action === 'copyChat' ? 'chat' : 'activity' });
      if (this.disposed || ticket !== this.ticket) return;
      if (result?.ok === true) {
        if (action === 'apply') {
          this.dirty = false; this.baseRevision = null;
          if (settings(result.result?.settings) && Number.isSafeInteger(result.result?.revision)) this.snapshot = { ...this.snapshot, sessionWidgets: result.result };
        }
        this.message = action === 'apply' ? 'saved' : 'copied';
      } else this.message = 'error';
    } catch { if (!this.disposed && ticket === this.ticket) this.message = 'error'; }
    finally { if (!this.disposed && ticket === this.ticket) { this.pending = false; this.signature = null; this.update(this.snapshot); } }
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.ticket++; for (const [node, event, listener] of this.listeners) node.removeEventListener(event, listener); this.listeners = []; }
}
