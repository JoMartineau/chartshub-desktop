const api = window.ChartsHubGameCapture;
const $ = id => document.getElementById(id);
const video = $('game'), selection = $('selection'), context = selection.getContext('2d');
let snapshot = null, stream = null, starting = false, disposed = false, drag = null, frame = null;
let listed = [], selectedId = '', lastWidth = 0, lastHeight = 0;
const peers = new Map(), canvases = new Map(), pendingCandidates = new Map();
const tr = (fr, en) => snapshot?.language === 'en' ? en : fr;
function status(fr, en) { $('status').textContent = tr(fr, en); }
async function command(name, value) { const result = await api.command(name, value); if (!result?.ok) throw Error('capture'); return result; }
function candidate(value) { return { candidate: value.candidate, sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null, usernameFragment: value.usernameFragment ?? null }; }
function closePeer(kind) {
  const peer = peers.get(kind); if (peer) { peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.close(); peers.delete(kind); }
  const entry = canvases.get(kind); if (entry) { entry.stream.getTracks().forEach(t => t.stop()); canvases.delete(kind); }
  pendingCandidates.delete(kind);
}
function cleanup() {
  if (frame !== null) { video.cancelVideoFrameCallback?.(frame); cancelAnimationFrame(frame); frame = null; }
  stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); stream = null; video.srcObject = null;
  for (const kind of [...peers.keys()]) closePeer(kind);
  canvases.clear(); drag = null; lastWidth = 0; lastHeight = 0;
  context.clearRect(0, 0, selection.width, selection.height);
}
function dimensions(rect) {
  const width = Math.max(1, Math.round(rect.width * video.videoWidth)), height = Math.max(1, Math.round(rect.height * video.videoHeight));
  const scale = Math.min(1, 1920 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale / 2) * 2), height: Math.max(2, Math.round(height * scale / 2) * 2) };
}
function drawCrop(kind, entry) {
  const r = snapshot?.crops[kind]; if (!r || !video.videoWidth) return;
  const size = dimensions(r);
  if (entry.canvas.width !== size.width) entry.canvas.width = size.width;
  if (entry.canvas.height !== size.height) entry.canvas.height = size.height;
  entry.context.drawImage(video, r.x * video.videoWidth, r.y * video.videoHeight, r.width * video.videoWidth, r.height * video.videoHeight, 0, 0, size.width, size.height);
}
function drawSelections() {
  selection.width = Math.max(1, video.videoWidth || 1280); selection.height = Math.max(1, video.videoHeight || 720);
  context.lineWidth = Math.max(2, selection.width / 400);
  const rows = Object.entries(snapshot?.crops ?? {}).filter(([,r]) => r);
  if (drag) rows.push([$('region').value, rectFrom(drag.from, drag.to)]);
  for (const [kind, r] of rows) {
    context.strokeStyle = kind === 'highway' ? '#5ae1fc' : '#ffd778';
    context.fillStyle = kind === 'highway' ? '#5ae1fc20' : '#ffd77820';
    context.fillRect(r.x * selection.width, r.y * selection.height, r.width * selection.width, r.height * selection.height);
    context.strokeRect(r.x * selection.width, r.y * selection.height, r.width * selection.width, r.height * selection.height);
  }
}
function tick() {
  if (!stream || disposed) return;
  if (video.videoWidth !== lastWidth || video.videoHeight !== lastHeight) {
    cleanup(); void command('failed').catch(() => {});
    status('La taille de la fenêtre a changé. Choisissez-la à nouveau et retracez les zones.', 'The window size changed. Select it again and redraw the regions.'); return;
  }
  for (const [kind, entry] of canvases) drawCrop(kind, entry);
  drawSelections();
  frame = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
}
async function connectOutput({kind, revision}) {
  if (!stream || revision !== snapshot?.revision || !snapshot.crops[kind]) return;
  closePeer(kind);
  const canvas = document.createElement('canvas'), entry = { canvas, context: canvas.getContext('2d'), stream: null };
  drawCrop(kind, entry); entry.stream = canvas.captureStream(60); canvases.set(kind, entry);
  const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); peers.set(kind, peer);
  peer.onicecandidate = event => { if (event.candidate && peers.get(kind) === peer) void command('signal', {kind, revision, signal:{candidate:candidate(event.candidate)}}).catch(() => {}); };
  peer.onconnectionstatechange = () => { if (peers.get(kind) === peer && ['failed','closed'].includes(peer.connectionState)) closePeer(kind); };
  for (const track of entry.stream.getVideoTracks()) peer.addTrack(track, entry.stream);
  try {
    const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
    if (peers.get(kind) === peer) await command('signal', {kind, revision, signal:{description:{type:offer.type,sdp:offer.sdp}}});
  } catch { closePeer(kind); status('Cette fenêtre de sortie ne répond pas. Fermez-la et rouvrez-la.', 'The output window is unavailable. Close and reopen it.'); }
}
async function receiveSignal({kind, revision, signal}) {
  const peer = peers.get(kind); if (!peer || revision !== snapshot?.revision) return;
  try {
    if (signal.description) {
      if (signal.description.type !== 'answer') return;
      await peer.setRemoteDescription(signal.description);
      for (const item of pendingCandidates.get(kind) ?? []) await peer.addIceCandidate(item);
      pendingCandidates.delete(kind);
    } else if (signal.candidate) {
      if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
      else { const queue = pendingCandidates.get(kind) ?? []; if (queue.length < 32) queue.push(signal.candidate); pendingCandidates.set(kind, queue); }
    }
  } catch { closePeer(kind); }
}
function render(value) {
  snapshot = value; const active = value.phase !== 'stopped';
  document.documentElement.lang = value.language;
  $('heading').textContent = tr('Highway et score du jeu', 'Game highway and score');
  $('intro').textContent = tr('Choisissez la fenêtre Clone Hero, démarrez l’aperçu, puis tracez les deux zones à la souris. Les notes et le panneau sont ceux du jeu ; le fond présent dans chaque zone est également capturé.', 'Choose the Clone Hero window, start the preview, then draw both regions. These are the game’s actual notes and score panel; each region also includes the game background behind it.');
  $('refresh').textContent = tr('Actualiser les fenêtres', 'Refresh windows');
  $('start').textContent = tr('Démarrer la capture', 'Start capture'); $('stop').textContent = tr('Arrêter la capture', 'Stop capture');
  $('region-label').textContent = tr('Zone à tracer', 'Region to draw');
  $('region').options[0].textContent = tr('Highway et notes', 'Highway and notes'); $('region').options[1].textContent = tr('Panneau du score', 'Score panel');
  $('open-highway').textContent = tr('Ouvrir Highway pour OBS', 'Open Highway for OBS'); $('open-score').textContent = tr('Ouvrir Score pour OBS', 'Open Score for OBS');
  $('instructions').textContent = tr('Dans OBS, ajoutez deux sources « Capture de fenêtre » : ChartsHub — Highway et ChartsHub — Score. Conservez ces fenêtres et cet aperçu ouverts. Cette capture contient le fond du jeu, sans transparence séparant ses éléments.', 'In OBS, add two Window Capture sources: ChartsHub — Highway and ChartsHub — Score. Keep these windows and this preview open. The game background inside each region remains part of the image.');
  $('safety').textContent = tr('La capture reste arrêtée à l’ouverture. Fermer cet aperçu ou cliquer sur Arrêter met fin à la capture. Une fenêtre disparue doit être choisie à nouveau.', 'Capture starts only when you click Start. Closing this preview or clicking Stop ends capture. A lost window must be selected again.');
  $('source').disabled = active || starting; $('refresh').disabled = active || starting;
  $('start').disabled = active || starting || !value.selected; $('stop').disabled = !active && !starting;
  $('region').disabled = value.phase !== 'capturing';
  for (const kind of ['highway','score']) $('open-'+kind).disabled = value.phase !== 'capturing' || !value.crops[kind];
  sizePreview();
  if (value.error) status('Capture interrompue. Actualisez les fenêtres et choisissez Clone Hero à nouveau.', 'Capture stopped. Refresh the window list and select Clone Hero again.');
  else if (value.phase === 'capturing') status('Aperçu actif. Tracez la highway et le panneau du score.', 'Preview active. Draw the highway and score regions.');
  else if (value.phase === 'starting') status('Démarrage de la capture…', 'Starting capture…');
  else status('Capture arrêtée.', 'Capture stopped.');
  if (!value.selected) { selectedId = ''; $('source').value = ''; }
}
function sizePreview() {
  const ratio = snapshot?.dimensions ? snapshot.dimensions.width / snapshot.dimensions.height : 16/9;
  $('preview').style.aspectRatio = String(ratio);
  $('preview').style.width = `min(100%, ${Math.max(140, innerHeight - 460) * ratio}px)`;
}
async function listWindows() {
  try {
    const result = await command('list'); listed = result.sources;
    $('source').replaceChildren(new Option(tr('Choisir une fenêtre…','Choose a window…'), ''));
    for (const item of listed) $('source').add(new Option(item.name, item.id));
    if (listed.some(s => s.id === selectedId)) $('source').value = selectedId;
    if (!listed.length) status('Aucune fenêtre Clone Hero trouvée. Ouvrez le jeu vous-même, puis actualisez.', 'No Clone Hero window found. Open the game yourself, then refresh.');
  } catch { status('Impossible de lister les fenêtres.', 'Could not list windows.'); }
}
$('refresh').addEventListener('click', listWindows);
$('source').addEventListener('change', async () => {
  const item = listed.find(s => s.id === $('source').value);
  if (!item) { selectedId = ''; void command('select', {id:''}).catch(() => {}); return; }
  try { await command('select', {id:item.id}); selectedId = item.id; }
  catch { status('Actualisez les fenêtres puis réessayez.', 'Refresh the window list and try again.'); }
});
$('start').addEventListener('click', async () => {
  if (starting || stream || !snapshot?.selected) return;
  starting = true; render(snapshot);
  try {
    const current = await navigator.mediaDevices.getDisplayMedia({ audio:false, video:{ frameRate:{ideal:60,max:60} } });
    if (disposed || snapshot?.phase === 'stopped' && !starting) { current.getTracks().forEach(t => t.stop()); return; }
    stream = current; const track = current.getVideoTracks()[0];
    if (!track || current.getAudioTracks().length) throw Error('Unexpected tracks');
    track.onended = () => { cleanup(); void command('stop').catch(() => {}); };
    video.srcObject = current; await video.play();
    lastWidth = video.videoWidth; lastHeight = video.videoHeight;
    await command('started', {width:lastWidth,height:lastHeight}); tick();
  } catch { cleanup(); void command('failed').catch(() => {}); }
  finally { starting = false; if (snapshot) render(snapshot); }
});
$('stop').addEventListener('click', () => { starting = false; cleanup(); void command('stop').catch(() => {}); });
for (const kind of ['highway','score']) $('open-'+kind).addEventListener('click', () => { void command('output', {kind}).catch(() => status('Sélectionnez cette zone sur l’aperçu.', 'Select this region in the preview.')); });
function point(event) { const r = selection.getBoundingClientRect(); return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))}; }
function rectFrom(a,b) { return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}; }
selection.addEventListener('pointerdown', event => { if (snapshot?.phase !== 'capturing' || event.button !== 0) return; drag = {from:point(event),to:point(event)}; selection.setPointerCapture(event.pointerId); });
selection.addEventListener('pointermove', event => { if (drag) drag.to = point(event); });
selection.addEventListener('pointerup', event => {
  if (!drag) return; const rect = rectFrom(drag.from,point(event)); drag = null;
  if (rect.width * video.videoWidth >= 8 && rect.height * video.videoHeight >= 8) void command('crop', {kind:$('region').value,rect}).catch(() => {});
});
selection.addEventListener('pointercancel', () => { drag = null; });
const unsubscribers = [api.subscribe('state',render), api.subscribe('stop', () => { starting = false; cleanup(); }),
  api.subscribe('output-ready', value => void connectOutput(value)), api.subscribe('output-closed',closePeer),
  api.subscribe('signal', value => void receiveSignal(value))];
window.addEventListener('resize',sizePreview);
window.addEventListener('beforeunload', () => { disposed = true; cleanup(); unsubscribers.forEach(fn => fn()); }, {once:true});
const initial = await command('snapshot'); render(initial.state); await listWindows();
