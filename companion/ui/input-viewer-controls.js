import { languageCode, localizedPair } from './locale-text.js';
export class InputViewerControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.busy = false; this.disposed = false;
    this.abort = new AbortController();
    const make = tag => { const node = root.ownerDocument.createElement(tag); root.append(node); return node; };
    this.heading = make('h3'); this.description = make('p'); this.description.className = 'helper-text';
    const button = (id, action) => {
      const node = make('button'); node.id = id; node.type = 'button'; node.className = 'button secondary';
      node.addEventListener('click', () => void action(), { signal: this.abort.signal }); return node;
    };
    this.button = button('input-viewer-open', () => this.open());
    this.stopButton = button('input-viewer-stop', () => this.perform('inputViewer.stop', {}, this.tr('Lecture des entrées arrêtée.', 'Input reading stopped.')));
    this.showButton = button('input-viewer-show-output', () => this.perform('inputViewer.showOutput', { editing: false }));
    this.positionButton = button('input-viewer-position-output', () => this.perform('inputViewer.showOutput', { editing: !(this.snapshot?.inputViewer?.outputOpen === true && this.snapshot.inputViewer.outputEditing === true) }));
    this.hideButton = button('input-viewer-hide-output', () => this.perform('inputViewer.hideOutput', {}));
    this.copyButton = button('input-viewer-copy-url', () => this.perform('inputViewer.copyUrl', {}, this.tr('Lien navigateur OBS copié.', 'OBS browser link copied.')));
    this.topLabel = make('label'); this.topLabel.className = 'helper-text';
    this.topCheckbox = root.ownerDocument.createElement('input'); this.topCheckbox.id = 'input-viewer-always-on-top'; this.topCheckbox.type = 'checkbox';
    this.topText = root.ownerDocument.createElement('span'); this.topLabel.append(this.topCheckbox, this.topText);
    this.topCheckbox.addEventListener('change', () => void this.perform('inputViewer.showOutput', { editing: this.snapshot?.inputViewer?.outputEditing === true, alwaysOnTop: this.topCheckbox.checked }), { signal: this.abort.signal });
    this.status = make('p'); this.status.className = 'helper-text'; this.status.setAttribute('role', 'status');
    this.feedback = make('p'); this.feedback.className = 'helper-text'; this.feedback.setAttribute('role', 'status'); this.feedback.hidden = true;
    this.update(null);
  }
  tr(fr, en) { return localizedPair(languageCode(this.snapshot?.language), fr, en); }
  update(snapshot) {
    if (this.disposed) return; this.snapshot = snapshot;
    this.heading.textContent = this.tr('Input Viewer — guitare et batterie', 'Input Viewer — guitar and drums');
    const viewer = snapshot?.inputViewer, available = viewer?.available === true, opened = viewer?.outputOpen === true, editing = opened && viewer?.outputEditing === true;
    const hasUrl = typeof snapshot?.stream?.inputViewerUrl === 'string' && snapshot.stream.inputViewerUrl.length > 0;
    this.description.textContent = this.tr('Personnalisez les touches, couleurs, formes et traînées, puis cliquez sur Démarrer dans les réglages. Vous pouvez ensuite fermer les réglages : la manette et les widgets Jeu / OBS restent actifs. Utilisez Arrêter la lecture pour les arrêter. Dans OBS, ajoutez une source Navigateur avec son lien. Le clavier nécessite la fenêtre des réglages active. Lecture des touches sans MelonLoader ; automatismes via le module Widgets facultatif.', 'Customize inputs, colors, shapes and trails, then click Start in settings. You can then close settings: the controller and Game / OBS widgets stay active. Use Stop input reading to stop them. In OBS, add a Browser Source with its link. Keyboard input requires the settings window to be focused. Input reading works without MelonLoader; automation uses the optional Game Widgets module.');
    this.button.textContent = this.tr('Ouvrir et personnaliser l’Input Viewer', 'Open and customize Input Viewer');
    this.stopButton.textContent = this.tr('Arrêter la lecture', 'Stop input reading');
    this.showButton.textContent = this.tr('Afficher au-dessus du jeu', 'Show over the game');
    this.positionButton.textContent = editing ? this.tr('Verrouiller la position', 'Lock position') : this.tr('Déplacer et redimensionner', 'Move and resize');
    this.hideButton.textContent = this.tr('Masquer le widget du jeu', 'Hide game widget');
    this.copyButton.textContent = hasUrl ? this.tr('Copier le lien navigateur OBS', 'Copy OBS browser link') : this.tr('Activer Stream et copier le lien OBS', 'Enable Stream and copy OBS link');
    this.topText.textContent = this.tr(' Au-dessus du jeu', ' Always on top'); this.topCheckbox.checked = viewer?.outputAlwaysOnTop !== false;
    this.button.disabled = this.busy || !available;
    this.stopButton.disabled = this.busy || !available || viewer?.phase !== 'running';
    this.showButton.disabled = this.busy || !available || opened && !editing;
    this.positionButton.disabled = this.busy || !available;
    this.hideButton.disabled = this.busy || !available || !opened;
    this.copyButton.disabled = this.busy || !available;
    this.topCheckbox.disabled = this.busy || !available || !opened;
    const outputState = !opened ? this.tr('Widget du jeu masqué.', 'Game widget hidden.') : editing ? this.tr('Positionnement actif : déplacez le widget, puis verrouillez sa position.', 'Positioning active: move the widget, then lock its position.') : this.tr('Widget du jeu affiché ; les clics traversent le widget.', 'Game widget visible; clicks pass through it.');
    const readingState = viewer?.phase === 'running' ? viewer.open === false ? this.tr('Lecture active en arrière-plan ; réglages fermés.', 'Input reading active in the background; settings closed.') : this.tr('Lecture active.', 'Input reading active.') : this.tr('Lecture arrêtée.', 'Input reading stopped.');
    this.status.textContent = !available ? this.tr('Input Viewer indisponible.', 'Input Viewer unavailable.') : `${readingState} ${outputState} ${hasUrl ? this.tr('Lien navigateur OBS prêt.', 'OBS browser link ready.') : this.tr('Le bouton OBS active le serveur Stream si nécessaire.', 'The OBS button enables the Stream server if needed.')}`;
  }
  async open() { return this.perform('inputViewer.open', {}); }
  async perform(command, payload, success) {
    if (this.disposed || this.busy) return;
    this.busy = true; this.feedback.hidden = true; this.update(this.snapshot);
    try {
      const result = await this.command(command, payload);
      if (!result?.ok) throw Error(result?.error || this.tr('L’action Input Viewer a échoué.', 'The Input Viewer action failed.'));
      if (!this.disposed && success) { this.feedback.textContent = success; this.feedback.hidden = false; }
    }
    catch (error) { if (!this.disposed) { this.feedback.textContent = error.message; this.feedback.hidden = false; } }
    finally { this.busy = false; if (!this.disposed) this.update(this.snapshot); }
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}
