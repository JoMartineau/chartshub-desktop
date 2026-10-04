import { FiltersControls } from './filters-controls.js';
import { ReShadeControls } from './reshade-controls.js';
const api = window.ChartsHubCompanion;
let disposed = false, received = false, unsubscribe = () => {};
const command = async (name, payload) => {
  const result = await api.command(name, payload);
  if (!disposed) update(await api.getSnapshot());
  return result;
};
const controls = new FiltersControls({ root: document.querySelector('#filters-widget-legacy'), mini: true, command });
const reshade = new ReShadeControls({ root: document.querySelector('#reshade-widget-controls'), mini: true, command });
function update(snapshot) { controls.update(snapshot); reshade.update(snapshot); }
document.querySelector('#filters-widget-engine').addEventListener('change', event => {
  document.querySelector('#reshade-widget-controls').hidden = event.target.value !== 'reshade';
  document.querySelector('#filters-widget-legacy').hidden = event.target.value !== 'classic';
});
async function connect() {
  if (!api) return;
  try {
    unsubscribe = api.subscribe(snapshot => { if (!disposed) { received = true; update(snapshot); } });
    const snapshot = await api.getSnapshot();
    if (!disposed && !received && snapshot) update(snapshot);
  } catch { controls.feedback('La connexion à ChartsHub est indisponible.'); reshade.feedback('La connexion à ChartsHub est indisponible.'); }
}
window.addEventListener('beforeunload', () => { disposed = true; unsubscribe(); controls.dispose(); reshade.dispose(); }, { once: true });
void connect();
