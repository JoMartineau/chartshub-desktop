'use strict';
const { parseCommand } = require('./song-requests.cjs');
const { replyFor } = require('./song-request-server.cjs');
const { createTwitchSongRequestConnection } = require('./song-request-twitch.cjs');
const { createTikTokSongRequestConnection } = require('./song-request-tiktok.cjs');

/** Native provider events share the same installed-library queue as the local bridge. */
function createSongRequestConnections({ accountStore, twitchClientId = '', openExternal, receive,
  canReceive = () => false, getLanguage = () => 'fr', onChange, now = Date.now,
  createTwitch = createTwitchSongRequestConnection, createTikTok = createTikTokSongRequestConnection } = {}) {
  let receiving = false, generation = 0, pending = 0, tail = Promise.resolve(), lastResponse = null;
  const epochs = { twitch: 0, tiktok: 0 }, accepting = { twitch: false, tiktok: false }, seen = new Map(), replyTimes = [];
  const notify = () => { try { onChange?.(); } catch {} };
  const active = () => receiving && canReceive();
  function incoming(platform, event) {
    if (!active() || !accepting[platform] || providers[platform].status().state !== 'connected' || pending >= 20 || !event || event.platform !== platform
        || typeof event.query !== 'string' || event.query.length > 256 || !parseCommand(event.query)
        || typeof event.eventId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(event.eventId)) return;
    const time = now();
    for (const [key, expiry] of seen) if (expiry <= time) seen.delete(key);
    const key = platform + ':' + event.eventId;
    if (seen.has(key)) return;
    if (seen.size >= 1000) seen.delete(seen.keys().next().value);
    seen.set(key, time + 600000);
    const ticket = generation, epoch = epochs[platform]; pending++;
    const valid = () => ticket === generation && epoch === epochs[platform] && accepting[platform] && active();
    const task = tail.then(async () => {
      if (!valid()) return;
      const result = await receive({ platform, eventId: event.eventId, viewerId: event.viewerId, viewerName: event.viewerName, query: event.query });
      if (!valid()) return;
      const message = replyFor(result, getLanguage()).slice(0, 500);
      // Receive-only providers still give the streamer visible feedback locally.
      lastResponse = { platform, message }; notify();
      if (platform !== 'twitch' || result?.code === 'duplicate_event') return;
      const at = now();
      while (replyTimes.length && replyTimes[0] <= at - 30000) replyTimes.shift();
      if (replyTimes.length >= 10) return;
      replyTimes.push(at);
      await providers.twitch.sendReply(message);
    }).catch(() => { /* Provider/queue details never enter logs or renderer snapshots. */ }).finally(() => { pending--; });
    tail = task;
  }
  const providers = {
    twitch: createTwitch({ clientId: twitchClientId, accountStore, openExternal, onStatus: notify, onMessage: event => incoming('twitch', event) }),
    tiktok: createTikTok({ onStatus: notify, onMessage: event => incoming('tiktok', event) })
  };
  function status() {
    // Explicit projection; an injected provider cannot accidentally expose credentials.
    const value = { receiving, persistent: accountStore.status().persistent, storageError: accountStore.status().error, lastResponse };
    for (const platform of ['twitch', 'tiktok']) {
      const source = providers[platform].status();
      value[platform] = { state: source.state, displayName: source.displayName ?? null, error: source.error ?? null, canReply: platform === 'twitch',
        ...(platform === 'twitch' && typeof source.userCode === 'string' ? { userCode: source.userCode.slice(0, 32) } : {}) };
    }
    return structuredClone(value);
  }
  async function connect(platform, payload) {
    if (!providers[platform]) return { ok: false };
    epochs[platform]++; accepting[platform] = true;
    // A previous Disconnect/Cancel stops that provider's reception flag. Restore
    // the current session choice when reconnecting, including during consent.
    await Promise.all([
      providers[platform].connect(platform === 'tiktok' ? { username: payload?.username } : undefined),
      providers[platform].setReceiving(receiving)
    ]);
    notify(); return { ok: providers[platform].status().state !== 'error' };
  }
  async function disconnect(platform) {
    if (!providers[platform]) return { ok: false };
    epochs[platform]++; accepting[platform] = false;
    await providers[platform].disconnect(); notify(); return { ok: true };
  }
  async function cancelAuth(platform) {
    if (platform !== 'twitch') return { ok: false };
    epochs.twitch++; accepting.twitch = false;
    await providers.twitch.stop();
    // stop cancels consent without forgetting a previously remembered account.
    notify(); return { ok: true };
  }
  async function setReceiving(enabled) {
    receiving = enabled === true; generation++;
    await Promise.allSettled(Object.values(providers).map(provider => provider.setReceiving(receiving)));
    notify();
  }
  function handlesBridge(platform) {
    const value = providers[platform]?.status();
    return receiving && accepting[platform] && !!value?.displayName && ['connecting', 'connected'].includes(value.state);
  }
  async function stop() {
    receiving = false; generation++; epochs.twitch++; epochs.tiktok++; accepting.twitch = accepting.tiktok = false;
    await Promise.allSettled(Object.values(providers).map(provider => provider.stop()));
    await tail; await accountStore.flush(); notify();
  }
  return { status, connect, disconnect, cancelAuth, setReceiving, handlesBridge, stop };
}
module.exports = { createSongRequestConnections };
