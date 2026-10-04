import { createDefaultRegistry } from '/dist/widgets/core/index.js';
import { WidgetRenderer } from '/dist/widgets/engine/WidgetRenderer.js';
import { StreamRenderer } from '/dist/overlay/stream/StreamRenderer.js';

const root = document.querySelector('#stream-overlay');
const renderer = new StreamRenderer(root, new WidgetRenderer(createDefaultRegistry()));
const token = new URL(location.href).searchParams.get('token');
let socket = null, reconnect = null, delay = 1000, lastContact = 0, disposed = false;
const clear = () => renderer.clear();

function scheduleReconnect() {
  if (disposed || reconnect) return;
  reconnect = setTimeout(() => { reconnect = null; connect(); }, delay);
  delay = Math.min(delay * 2, 10000);
}
function connect() {
  if (disposed || !token || !/^[0-9a-f]{64}$/i.test(token)) { clear(); return; }
  clear();
  lastContact = Date.now();
  const connection = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);
  socket = connection;
  connection.addEventListener('open', () => { if (socket === connection) lastContact = Date.now(); });
  connection.addEventListener('message', event => {
    if (disposed || socket !== connection || typeof event.data !== 'string' || event.data.length > 262144) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'heartbeat') { lastContact = Date.now(); return; }
      if (message.type !== 'snapshot' || !message.state || !Array.isArray(message.state.widgets?.instances)) return;
      renderer.render(message.state);
      lastContact = Date.now(); delay = 1000;
    } catch { clear(); }
  });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    socket = null; clear(); scheduleReconnect();
  });
  connection.addEventListener('error', () => {
    if (socket !== connection) return;
    clear(); connection.close();
  });
}
const watchdog = setInterval(() => {
  if (socket && lastContact && Date.now() - lastContact > 25000) {
    const expired = socket; socket = null; clear(); expired.close(); scheduleReconnect();
  }
}, 1000);
window.addEventListener('beforeunload', () => {
  disposed = true; clearTimeout(reconnect); clearInterval(watchdog);
  socket?.close(); socket = null; renderer.dispose();
}, { once: true });
connect();
