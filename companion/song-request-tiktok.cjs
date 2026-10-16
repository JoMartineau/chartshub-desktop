'use strict';

// Local, anonymous LIVE reception only. The connector uses Euler Stream's
// community signing service; no TikTok session, credentials or API key is used.
const CONNECTION_TIMEOUT_MS = 30000;
const SEEN_MESSAGE_LIMIT = 1000;
const COMMAND = /^!(?:sr|vote|queue|song)(?:\s|$)/i;

function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length > 26) return null;
  const username = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_](?:[a-z0-9_.]{0,22}[a-z0-9_])?$/.test(username) ? username : null;
}

function positiveId(value) {
  if (typeof value === 'bigint') value = value.toString();
  else if (typeof value === 'number') value = Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value) ? value : null;
}

function normalizeMessage(data) {
  if (!data || typeof data !== 'object' || !data.user || typeof data.user !== 'object') return null;
  const eventId = positiveId(data.common?.msgId);
  // The pinned 2.5 connector emits the v3 protobuf schema, not the legacy
  // comment/userId/uniqueId shape still shown by some connector examples.
  const viewerId = positiveId(data.user.id ?? data.user.userId);
  const content = data.content ?? data.comment;
  const query = typeof content === 'string' ? content.trim() : '';
  if (!eventId || !viewerId || !query || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query) || !COMMAND.test(query)) return null;
  const nickname = typeof data.user.nickname === 'string' ? data.user.nickname : '';
  const displayId = data.user.displayId ?? data.user.uniqueId;
  const uniqueId = typeof displayId === 'string' ? displayId : '';
  const viewerName = (nickname || uniqueId).replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80) || viewerId;
  return { platform: 'tiktok', eventId, viewerId, viewerName, query };
}

function errorCode(error) {
  // Never expose provider messages, URLs, headers, or response objects.
  const name = error?.constructor?.name;
  if (name === 'UserOfflineError') return 'not_live';
  if (name === 'SignatureRateLimitError' || error?.reason === 'Rate Limited') return 'rate_limited';
  if (name === 'ConnectTimeoutError') return 'connection_timeout';
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') return 'provider_unavailable';
  return 'connection_failed';
}

async function createDefaultConnection(username, options) {
  // Importing this ESM dependency cannot initiate a connection at app startup.
  const [{ TikTokLiveConnection }, { default: EulerStreamApiClient }] = await Promise.all([
    import('tiktok-live-connector'), import('tiktok-live-api-sdk')
  ]);
  // The SDK's global client otherwise inherits SIGN_API_URL/SIGN_API_KEY and
  // caches them across instances. Keep this public-handle connection anonymous,
  // bounded and cancellable on both TikTok and the community signing service.
  const eulerApiInstance = new EulerStreamApiClient({
    basePath: 'https://api.eulerstream.com',
    baseOptions: { timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024, maxBodyLength: 64 * 1024,
      signal: options.webClientOptions.signal, headers: { 'User-Agent': 'ChartsHub-SongRequest' }, validateStatus: () => true }
  });
  return new TikTokLiveConnection(username, { ...options, eulerApiInstance });
}

function createTikTokSongRequestConnection({ createConnection = createDefaultConnection, onMessage = () => {}, onStatus = () => {}, connectTimeoutMs = CONNECTION_TIMEOUT_MS } = {}) {
  if (typeof createConnection !== 'function' || typeof onMessage !== 'function' || typeof onStatus !== 'function') throw new TypeError('Invalid TikTok connection callbacks');
  const timeoutMs = Number.isInteger(connectTimeoutMs) && connectTimeoutMs >= 1 && connectTimeoutMs <= CONNECTION_TIMEOUT_MS ? connectTimeoutMs : CONNECTION_TIMEOUT_MS;
  let username = null;
  let receiving = false;
  let current = null;
  let state = 'disconnected';
  let error = null;
  const seen = new Set();
  const status = () => ({ state, displayName: username ? `@${username}` : null, error, canReply: false });
  const publish = () => { try { onStatus(status()); } catch {} };
  const isCurrent = record => current === record && receiving && username === record.username;

  function finish(record) {
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    record.resolve(status());
  }

  function closeClient(record) {
    if (!record) return;
    record.controller.abort();
    if (!record.client) return;
    // disconnect() may finish before an in-flight connect() creates its socket.
    // The late connected handler below closes that socket as well.
    try { record.client.wsClient?.terminate?.(); } catch {}
    try { Promise.resolve(record.client.disconnect()).catch(() => {}); } catch {}
  }

  function fail(record, code) {
    if (!isCurrent(record)) return;
    current = null;
    state = 'error'; error = code;
    finish(record); closeClient(record); publish();
  }

  function halt(forgetUsername) {
    const previous = current;
    current = null;
    if (forgetUsername) { username = null; seen.clear(); }
    state = 'disconnected'; error = null;
    if (previous) { finish(previous); closeClient(previous); }
    publish();
    return status();
  }

  function start() {
    if (!receiving || !username) return Promise.resolve(status());
    if (current) return current.done;
    const record = { username, client: null, controller: new AbortController(), timer: null, resolve: null, done: null };
    record.done = new Promise(resolve => { record.resolve = resolve; });
    current = record; state = 'connecting'; error = null; publish();
    record.timer = setTimeout(() => fail(record, 'connection_timeout'), timeoutMs);
    void (async () => {
      try {
        const client = record.client = await createConnection(record.username, {
          processInitialData: false,
          fetchRoomInfoOnConnect: true,
          enableExtendedGiftInfo: false,
          authenticateWs: false,
          useMobile: false,
          webClientOptions: { timeout: { request: 10000 }, retry: { limit: 0 }, signal: record.controller.signal },
          wsClientOptions: { handshakeTimeout: 10000, maxPayload: 1024 * 1024, signal: record.controller.signal }
        });
        if (!client || typeof client.on !== 'function' || typeof client.connect !== 'function' || typeof client.disconnect !== 'function') throw new Error('Invalid TikTok provider');
        // Keep the guarded error listener for the lifetime of this transport so
        // a late provider error after cancellation cannot become uncaught.
        client.on('error', event => { if (isCurrent(record)) fail(record, errorCode(event?.exception ?? event)); });
        client.on('connected', () => {
          if (!isCurrent(record)) { closeClient(record); return; }
          state = 'connected'; error = null; finish(record); publish();
        });
        client.on('disconnected', () => { if (isCurrent(record)) fail(record, 'connection_closed'); });
        client.on('streamEnd', () => { if (isCurrent(record)) fail(record, 'not_live'); });
        client.on('chat', data => {
          if (!isCurrent(record) || state !== 'connected') return;
          const message = normalizeMessage(data);
          if (!message || seen.has(message.eventId)) return;
          seen.add(message.eventId);
          if (seen.size > SEEN_MESSAGE_LIMIT) seen.delete(seen.values().next().value);
          try { Promise.resolve(onMessage(message)).catch(() => {}); } catch {}
        });
        if (!isCurrent(record)) { closeClient(record); return; }
        await client.connect();
        if (!isCurrent(record)) { closeClient(record); return; }
        // Providers normally emit connected before resolving, but the public
        // promise also establishes readiness when an injected provider does not.
        if (state !== 'connected') { state = 'connected'; error = null; finish(record); publish(); }
      } catch (cause) {
        if (isCurrent(record)) fail(record, errorCode(cause));
        else closeClient(record);
      }
    })();
    return record.done;
  }

  async function connect(input) {
    const next = normalizeUsername(input?.username);
    if (!next) return { ...status(), error: 'invalid_username' };
    if (username !== next) { halt(false); username = next; seen.clear(); publish(); }
    return start();
  }

  function setReceiving(enabled) {
    receiving = enabled === true;
    if (!receiving) return Promise.resolve(halt(false));
    return start();
  }

  function stop() { receiving = false; return Promise.resolve(halt(false)); }
  function disconnect() { receiving = false; return Promise.resolve(halt(true)); }
  return { status, connect, setReceiving, stop, disconnect };
}

module.exports = { createTikTokSongRequestConnection, normalizeUsername, normalizeMessage, createDefaultConnection };
