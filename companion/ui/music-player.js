import { LocalMusicPlayerControls } from '../dist/settings/LocalMusicPlayerControls.js';
import { LocalMusicPlayerEngine } from '../dist/player/LocalMusicPlayerEngine.js';

const api = window.ChartsHubCompanion;
let disposed = false, received = false, unsubscribe = () => {}, unsubscribeActions = () => {}, lastSnapshot = null;
const controls = new LocalMusicPlayerControls({ root: document.querySelector('#local-music-player-panel'), compact: true, command: async (name, payload) => {
  const result = await api.command(name, payload);
  if (!disposed && name !== 'player.search') update(await api.getSnapshot());
  return result;
} });
const engine = new LocalMusicPlayerEngine({
  report: state => {
    if (lastSnapshot?.player && state.revision === lastSnapshot.player.revision) {
      controls.update({ ...lastSnapshot, player: { ...lastSnapshot.player, ...state, error: state.errorCode ?? null } });
    }
    return api.command('player.report', state);
  },
  spectrum: state => { controls.spectrum(state); return api.command('player.spectrum', state); },
  ended: ({ revision, epoch }) => api.command('player.ended', { revision, epoch }),
});
function update(snapshot) {
  if (disposed || !snapshot?.player) return;
  document.documentElement.lang = snapshot.language === 'fr' ? 'fr' : 'en';
  lastSnapshot = snapshot; controls.update(snapshot); engine.update(snapshot.player);
}
async function connect() {
  try {
    unsubscribeActions = api.player.subscribeAction(action => engine.action(action));
    unsubscribe = api.subscribe(snapshot => { received = true; update(snapshot); });
    const snapshot = await api.getSnapshot(); if (!received) update(snapshot);
  } catch { document.querySelector('#local-player-status').textContent = document.documentElement.lang === 'fr' ? 'Lecteur indisponible.' : 'Player unavailable.'; }
}
window.addEventListener('beforeunload', () => { disposed = true; unsubscribe(); unsubscribeActions(); engine.dispose(); controls.dispose(); }, { once: true });
void connect();
