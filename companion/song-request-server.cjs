'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const TOKENS = /^[a-f0-9]{64}$/;
const ASSETS = { '/overlay': 'song-requests.html', '/ui/song-requests-overlay.js': 'song-requests-overlay.js', '/ui/song-requests-overlay.css': 'song-requests-overlay.css' };
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 512) : '';
function overlayState(snapshot) {
  return { enabled: snapshot?.enabled === true, requests: (Array.isArray(snapshot?.requests) ? snapshot.requests : []).filter(row => ['pending', 'accepted'].includes(row?.status)).slice(0, 50).map(row => ({
    id: text(row.id), title: text(row.title), artist: text(row.artist), viewerName: text(row.viewerName),
    platform: ['twitch', 'tiktok', 'youtube'].includes(row.platform) ? row.platform : '',
    status: row.status, votes: Number.isSafeInteger(row.votes) && row.votes >= 0 ? Math.min(row.votes, 1000) : 0
  })) };
}
function replyFor(result, language = 'fr') {
  const tr = (fr, en) => language === 'en' ? en : fr;
  if (result?.ok && result.command === 'queue') {
    const queue = (result.items ?? []).slice(0, 5).map((song, i) => `${i + 1}. ${text(song.title)} — ${text(song.artist)}`).join(' | ');
    return queue ? tr('Prochains morceaux : ', 'Up next: ') + queue + (result.position ? tr(` · Ta demande : #${result.position}`, ` · Your request: #${result.position}`) : '') : tr('La file est vide.', 'The queue is empty.');
  }
  if (result?.ok && result.command === 'song') return tr(result.song?.exported ? 'Dernier morceau exporté : ' : 'Morceau actuel : ', result.song?.exported ? 'Last exported song: ' : 'Current song: ') + `${text(result.song?.title)} — ${text(result.song?.artist)} · ${text(result.song?.charter)}`;
  if (result?.ok && result.request) return tr(result.action === 'vote' ? 'Vote ajouté : ' : 'Demande ajoutée : ', result.action === 'vote' ? 'Vote added: ' : 'Request added: ') + `${text(result.request.title)} — ${text(result.request.artist)}`;
  if (result?.code === 'ambiguous' || result?.code === 'ambiguous_song') return tr('Choisis avec !sr id:IDENTIFIANT : ', 'Choose with !sr id:IDENTIFIER: ') + (result.matches ?? []).slice(0, 3).map(song => `${text(song.title).slice(0, 45)} — ${text(song.artist).slice(0, 25)} [${text(song.id)}]`).join(' | ');
  const errors = {
    disabled: ['Les demandes sont fermées.', 'Requests are closed.'], not_found: ['Aucune chanson installée ne correspond.', 'No installed song matches.'],
    not_playing: ['Le morceau actuel n’est pas disponible.', 'The current song is unavailable.'], cooldown: ['Attends un peu avant une nouvelle demande.', 'Wait a little before another request.'],
    viewer_limit: ['Tu as déjà deux demandes dans la file.', 'You already have two queued requests.'], queue_full: ['La file est pleine.', 'The queue is full.'],
    duplicate_vote: ['Ton vote est déjà compté.', 'Your vote is already counted.'], duplicate_event: ['Cette commande a déjà été reçue.', 'This command was already received.'],
    not_queued: ['Cette chanson n’est pas dans la file. Ajoute-la avec !sr.', 'This song is not queued. Add it with !sr.'], vote_limit: ['La limite de votes est atteinte.', 'The vote limit was reached.'],
    duration_limit: ['Cette chanson dépasse la durée maximale.', 'This song exceeds the maximum duration.'], instrument_unavailable: ['L’instrument demandé est indisponible dans cette chart.', 'The requested instrument is unavailable in this chart.'],
    difficulty_unavailable: ['La difficulté demandée est indisponible pour cet instrument.', 'The requested difficulty is unavailable for this instrument.'],
    metadata_unknown: ['Les informations de cette chart ne permettent pas de vérifier les règles de session.', 'This chart lacks the information needed to check session rules.'],
    library_changed: ['La bibliothèque a changé. Réessaie après le scan.', 'The library changed. Try again after scanning.'], song_unavailable: ['Cette chanson installée est indisponible. Actualise la bibliothèque.', 'This installed song is unavailable. Refresh the library.'],
    rate_limited: ['Trop de demandes. Réessaie dans un instant.', 'Too many requests. Try again shortly.']
  };
  const pair = errors[result?.code];
  return pair ? tr(...pair) : tr('Demande indisponible. Vérifie le titre et réessaie.', 'Request unavailable. Check the title and try again.');
}

/** The ingestion capability and OBS read capability are different secrets. Admin stays in native IPC. */
function createSongRequestServer({ root, ingestToken, readToken, receive, getSnapshot, getLanguage = () => 'fr', onStatus } = {}) {
  if (!TOKENS.test(ingestToken) || !TOKENS.test(readToken) || ingestToken === readToken || typeof root !== 'string' || typeof receive !== 'function' || typeof getSnapshot !== 'function') throw Error('Invalid Song Request server configuration');
  let context = null, serial = Promise.resolve(), generation = 0, desired = false, error = null, configuredPort = 38474;
  const directory = path.resolve(root), secret = Buffer.from(ingestToken, 'hex'), readSecret = Buffer.from(readToken, 'hex');
  const status = () => ({ enabled: !!context && !context.closing, port: configuredPort, url: context && !context.closing ? `http://127.0.0.1:${context.port}/song-requests` : null,
    overlayUrl: context && !context.closing ? `http://127.0.0.1:${context.port}/overlay?token=${readToken}` : null, error, platforms: ['twitch', 'tiktok', 'youtube'] });
  const notify = () => { try { onStatus?.(status()); } catch {} };
  const tokenMatches = (value, expected) => typeof value === 'string' && TOKENS.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), expected);
  function requestURL(ctx, request) {
    const host = `127.0.0.1:${ctx.port}`, raw = request.url ?? '';
    const count = name => request.rawHeaders.filter((_, i) => i % 2 === 0).filter(key => key.toLowerCase() === name).length;
    if (request.headers.host !== host || count('host') !== 1 || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)
      || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.split('?')[0].includes('%') || raw.split('?')[0].split('/').some(part => part === '.' || part === '..')) return null;
    try { const url = new URL(raw, `http://${host}`); return url.origin === `http://${host}` ? url : null; } catch { return null; }
  }
  function headers() { return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }; }
  async function handle(ctx, request, response) {
    const url = requestURL(ctx, request);
    const finish = (code, body, json = false) => { if (!response.destroyed) { response.writeHead(code, { ...headers(), 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' }); response.end(json ? JSON.stringify(body) : body); } };
    if (!url || ctx.closing || ctx !== context) return finish(403, 'Forbidden');
    if (request.method === 'POST' && url.pathname === '/song-requests' && !url.search) {
      if (request.headers.origin !== undefined || Object.keys(request.headers).some(name => name.startsWith('sec-fetch-'))) return finish(403, 'Forbidden');
      const auth = request.headers.authorization, authCount = request.rawHeaders.filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === 'authorization').length;
      if (authCount !== 1 || typeof auth !== 'string' || !auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), secret)) return finish(403, 'Forbidden');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding'] !== undefined) return finish(415, 'Unsupported media type');
      if (request.headers['content-length'] !== undefined && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > 8192)) return finish(413, 'Request too large');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) return finish(413, 'Request too large'); chunks.push(chunk); }
      if (ctx.closing || ctx !== context) return finish(503, 'Unavailable');
      let input;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5
          || Object.keys(input).some(key => !['platform', 'eventId', 'viewerId', 'viewerName', 'message'].includes(key))
          || typeof input.message !== 'string' || input.message.length > 200) throw Error();
      } catch { return finish(400, 'Invalid request'); }
      const result = await receive({ platform: input.platform, eventId: input.eventId, viewerId: input.viewerId, viewerName: input.viewerName, query: input.message });
      if (ctx.closing || ctx !== context) return finish(503, 'Unavailable');
      return finish(200, { ...result, reply: replyFor(result, getLanguage()).slice(0, 2000) }, true);
    }
    if (request.method !== 'GET') return finish(405, 'Method not allowed');
    const read = url.searchParams.getAll('token');
    if (url.pathname === '/state' || url.pathname === '/overlay') {
      if (read.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'token') || !tokenMatches(read[0], readSecret)) return finish(403, 'Forbidden');
    } else if (url.search) return finish(404, 'Not found');
    if (url.pathname === '/state') return finish(200, { ...overlayState(getSnapshot()), language: getLanguage() === 'en' ? 'en' : 'fr' }, true);
    const asset = ASSETS[url.pathname];
    if (!asset) return finish(404, 'Not found');
    const filename = path.join(directory, 'ui', asset), resolved = await fs.realpath(filename), base = await fs.realpath(path.join(directory, 'ui'));
    if (!resolved.startsWith(base + path.sep) || (await fs.stat(resolved)).size > 256 * 1024) return finish(404, 'Not found');
    const bytes = await fs.readFile(resolved);
    if (ctx.closing || ctx !== context) return finish(503, 'Unavailable');
    response.writeHead(200, { ...headers(), 'Content-Type': asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }); response.end(bytes);
  }
  async function close(ctx) {
    if (!ctx || ctx.closing) return;
    ctx.closing = true;
    await new Promise(resolve => { ctx.server.close(resolve); for (const socket of ctx.sockets) socket.destroy(); });
  }
  function start(port = configuredPort) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(Error('Invalid Song Request port'));
    configuredPort = port; desired = true; const ticket = ++generation;
    const task = serial.then(async () => {
      if (!desired || ticket !== generation) return status();
      if (context && context.requestedPort === port && !context.closing) return status();
      const previous = context; context = null; await close(previous);
      if (!desired || ticket !== generation) return status();
      const ctx = { server: null, sockets: new Set(), closing: false, port, requestedPort: port };
      ctx.server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => { void handle(ctx, req, res).catch(() => { if (!res.destroyed) { res.writeHead(500, headers()); res.end('Request unavailable'); } }); });
      ctx.server.on('clientError', (_error, socket) => socket.destroy());
      ctx.server.on('connection', socket => { if (ctx.sockets.size >= 16) return socket.destroy(); ctx.sockets.add(socket); socket.on('close', () => ctx.sockets.delete(socket)); });
      try {
        await new Promise((resolve, reject) => { ctx.server.once('error', reject); ctx.server.listen(port, '127.0.0.1', resolve); });
        ctx.port = ctx.server.address().port;
        if (!desired || ticket !== generation) { await close(ctx); return status(); }
        context = ctx; error = null;
        ctx.server.on('error', () => { error = 'Le pont Song Request est indisponible.'; void stop(); });
      } catch { await close(ctx); error = 'Le port Song Request est indisponible. Choisissez un autre port.'; }
      notify(); return status();
    }); serial = task.catch(() => {}); return task;
  }
  function stop() {
    desired = false; ++generation;
    const task = serial.then(async () => { const previous = context; context = null; await close(previous); notify(); return status(); }); serial = task.catch(() => {}); return task;
  }
  return { start, stop, status, setPort: port => { if (context || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid Song Request port'); configuredPort = port; notify(); }, bridgeConfiguration: () => context && !context.closing ? { url: status().url, token: ingestToken } : null };
}
module.exports = { createSongRequestServer, overlayState, replyFor };
