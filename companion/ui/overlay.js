import { createDefaultRegistry } from '../dist/widgets/core/index.js';
import { WidgetRenderer } from '../dist/widgets/engine/WidgetRenderer.js';
import { GameOverlay } from '../dist/overlay/game/GameOverlay.js';

const api = window.ChartsHubCompanion;
const overlay = new GameOverlay(document.querySelector('#game-overlay'), new WidgetRenderer(createDefaultRegistry()));
let receivedSnapshot = false;
let disposed = false;
let unsubscribe = () => {};

function render(snapshot) {
  if (disposed || !snapshot?.state) return;
  receivedSnapshot = true;
  overlay.render(snapshot.state);
  document.body.dataset.gameplayState = snapshot.state.gameplay.state;
}

async function connect() {
  if (!api) return;
  try {
    unsubscribe = api.subscribe(render);
    const initial = await api.getSnapshot();
    if (!receivedSnapshot) render(initial);
  } catch {
    // The initial canvas stays empty; a later subscription snapshot can recover.
  }
}

window.addEventListener('beforeunload', () => {
  disposed = true;
  unsubscribe();
  overlay.dispose();
}, { once: true });

void connect();
