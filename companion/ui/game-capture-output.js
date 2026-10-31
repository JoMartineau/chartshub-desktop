const api = window.ChartsHubGameCapture, video = document.getElementById('output');
let peer = null, revision = -1, queue = [], serial = Promise.resolve();
const candidate = c => ({candidate:c.candidate,sdpMid:c.sdpMid??null,sdpMLineIndex:c.sdpMLineIndex??null,usernameFragment:c.usernameFragment??null});
function close() { if (peer) { peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.close(); peer = null; } video.srcObject?.getTracks().forEach(t => t.stop()); video.srcObject = null; queue = []; }
async function receive(value) {
  if (value.revision !== revision) return;
  const signal = value.signal;
  if (signal.description) {
    if (signal.description.type !== 'offer') return;
    const pending = queue; close(); queue = pending;
    const current = new RTCPeerConnection({iceServers:[],bundlePolicy:'max-bundle'}); peer = current;
    current.onconnectionstatechange = () => { if (peer === current && ['failed','disconnected','closed'].includes(current.connectionState)) close(); };
    current.ontrack = event => { if (event.track.kind === 'video') { video.srcObject = new MediaStream([event.track]); void video.play().catch(() => {}); } };
    current.onicecandidate = event => { if (event.candidate && peer === current) void api.command('signal', {revision,signal:{candidate:candidate(event.candidate)}}); };
    await current.setRemoteDescription(signal.description);
    for (const item of queue) await current.addIceCandidate(item); queue = [];
    const answer = await current.createAnswer(); await current.setLocalDescription(answer);
    await api.command('signal', {revision,signal:{description:{type:answer.type,sdp:answer.sdp}}});
  } else if (signal.candidate) {
    if (peer?.remoteDescription) await peer.addIceCandidate(signal.candidate);
    else if (queue.length < 32) queue.push(signal.candidate);
  }
}
const unsubscribe = api.subscribe('signal', value => { serial = serial.then(() => receive(value)).catch(close); });
const stop = api.subscribe('stop',close);
window.addEventListener('beforeunload', () => { close(); unsubscribe(); stop(); }, {once:true});
const initial = await api.command('snapshot');
if (initial.ok) { revision = initial.state.revision; document.title = initial.state.outputs[initial.role].title; await api.command('ready'); }
