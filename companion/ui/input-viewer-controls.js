export class InputViewerControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.busy = false; this.disposed = false;
    this.abort = new AbortController();
    const make = tag => { const node = root.ownerDocument.createElement(tag); root.append(node); return node; };
    this.heading = make('h3'); this.description = make('p'); this.description.className = 'helper-text';
    this.button = make('button'); this.button.id = 'input-viewer-open'; this.button.type = 'button'; this.button.className = 'button secondary';
    this.feedback = make('p'); this.feedback.className = 'helper-text'; this.feedback.setAttribute('role', 'status'); this.feedback.hidden = true;
    this.button.addEventListener('click', () => void this.open(), { signal: this.abort.signal });
    this.update(null);
  }
  tr(fr, en) { return this.snapshot?.language === 'en' ? en : fr; }
  update(snapshot) {
    if (this.disposed) return; this.snapshot = snapshot;
    this.heading.textContent = this.tr('Input Viewer — guitare et batterie', 'Input Viewer — guitar and drums');
    this.description.textContent = this.tr('Personnalisez les touches, couleurs, formes et traînées. Dans OBS, utilisez Capture de fenêtre « ChartsHub — Input Viewer ». La lecture des entrées démarre uniquement avec votre bouton Démarrer ; le clavier nécessite cette fenêtre active. Sans MelonLoader et sans mesure Accuracy.', 'Customize inputs, colors, shapes and trails. In OBS, use Window Capture “ChartsHub — Input Viewer”. Input reading starts only with your Start button; keyboard input requires this window to be focused. No MelonLoader or Accuracy measurement.');
    this.button.textContent = this.tr('Ouvrir et personnaliser l’Input Viewer', 'Open and customize Input Viewer');
    this.button.disabled = this.busy || snapshot?.inputViewer?.available !== true;
  }
  async open() {
    if (this.disposed || this.busy) return;
    this.busy = true; this.feedback.hidden = true; this.update(this.snapshot);
    try { const result = await this.command('inputViewer.open', {}); if (!result?.ok) throw Error(result?.error || this.tr('L’Input Viewer ne peut pas être ouvert.', 'Input Viewer could not open.')); }
    catch (error) { if (!this.disposed) { this.feedback.textContent = error.message; this.feedback.hidden = false; } }
    finally { this.busy = false; if (!this.disposed) this.update(this.snapshot); }
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}
