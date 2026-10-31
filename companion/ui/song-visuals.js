import { visualTarget } from './song-visuals-sync.js';
const kind = location.pathname === '/background' ? 'background' : 'video';
const token = new URL(location.href).searchParams.get('token');
const image = document.querySelector('#background'), video = document.querySelector('#video'), notice = document.querySelector('#notice');
let disposed = false, busy = false, snapshot = null, receivedAt = 0, capability = null, failedCapability = null;
video.muted = true; video.volume = 0;
function clear() { snapshot = null; capability = null; image.hidden = video.hidden = true; image.removeAttribute('src'); video.pause(); video.removeAttribute('src'); video.load(); notice.hidden = true; document.body.dataset.state = 'waiting'; }
function source(generation) { return `/visual-media/${kind}/${generation}?token=${encodeURIComponent(token)}`; }
function apply(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.generation || '') || value[kind] !== true) { clear(); return; }
  snapshot = value; receivedAt = performance.now();
  if (capability !== value.generation) {
    clear(); snapshot = value; receivedAt = performance.now(); capability = value.generation; failedCapability = null;
    if (kind === 'background') { image.src = source(capability); image.hidden = false; }
    else video.src = source(capability);
  }
  document.body.dataset.state = failedCapability === capability ? 'unsupported' : 'ready';
}
async function poll() {
  if (disposed || busy || !/^[a-f0-9]{64}$/.test(token || '')) return;
  busy = true;
  try { const response = await fetch(`/visual-state?token=${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(1800) }); if (!response.ok) throw Error(); const value = await response.json(); if (!disposed) apply(value); }
  catch { clear(); } finally { busy = false; }
}
function tick() {
  if (disposed || kind !== 'video' || !snapshot || failedCapability === capability) return;
  const target = visualTarget(snapshot, (performance.now() - receivedAt) / 1000);
  if (!target) { clear(); return; }
  video.hidden = target.hidden; video.muted = true; video.volume = 0;
  if (video.readyState < 1) return;
  if (Number.isFinite(video.duration) && target.seconds >= video.duration) { video.pause(); video.hidden = true; return; }
  try {
    if (Math.abs(video.currentTime - target.seconds) > .2) video.currentTime = target.seconds;
    video.playbackRate = target.speed;
    if (target.playing) { const generation = capability; void video.play().catch(error => { if (!disposed && capability === generation && error?.name === 'NotSupportedError') unsupported(); }); }
    else video.pause();
  } catch { unsupported(); }
}
function reportDecode() {
  if (!capability || failedCapability === capability || disposed) return;
  failedCapability = capability;
  void fetch(`/visual-error?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ kind, generation: capability, code: 'decode' }), signal: AbortSignal.timeout(1800) }).catch(() => {});
}
function unsupported() { video.pause(); video.hidden = true; notice.hidden = true; document.body.dataset.state = 'unsupported'; reportDecode(); }
video.addEventListener('error', () => { if (capability && video.currentSrc.includes('/' + capability + '?')) unsupported(); });
image.addEventListener('error', () => { image.hidden = true; document.body.dataset.state = 'unavailable'; reportDecode(); });
video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; if (video.volume !== 0) video.volume = 0; });
const timer = setInterval(() => { void poll(); }, 250), animation = setInterval(tick, 50);
window.addEventListener('beforeunload', () => { disposed = true; clearInterval(timer); clearInterval(animation); clear(); }, { once: true });
void poll();
