'use strict';
const { ORIGIN } = require('../download');
const route = ORIGIN + '/api/account/song-request-library';
const failure = () => Error('Le partage est indisponible. Connectez votre compte ChartsHub et vérifiez la version du site.');
function createSongRequestSharing({ fetcher, readAccount, generation = () => 0 } = {}) {
  if (typeof fetcher !== 'function' || typeof readAccount !== 'function') throw failure();
  async function capture() {
    const before = generation(), user = await readAccount();
    if (before !== generation() || !user?.id || user.emailVerified !== true) throw failure();
    return Object.freeze({ generation: before, userId: user.id });
  }
  async function request(method, payload, captured) {
    const before = generation(), user = await readAccount();
    if (before !== generation() || !user?.id || user.emailVerified !== true) throw failure();
    if (captured && (captured.generation !== before || captured.userId !== user.id)) throw failure();
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > 5 * 1024 * 1024) throw failure();
    const response = await fetcher(route, { method, credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { Origin: ORIGIN, 'X-ChartsHub-Account-Id': user.id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
    if (!response.ok || before !== generation()) throw failure();
    const data = await response.json();
    const after = await readAccount();
    if (before !== generation() || after?.id !== user.id || after?.emailVerified !== true) throw failure();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure();
    if (data.library === null) return { url: null, count: 0, updatedAt: null };
    const library = data.library;
    if (!library || typeof library.token !== 'string' || !/^[a-f0-9]{64}$/.test(library.token) || !Number.isInteger(library.count) || library.count < 0 || library.count > 10000
      || typeof library.updatedAt !== 'string' || !Number.isFinite(Date.parse(library.updatedAt))) throw failure();
    return { url: ORIGIN + '/song-requests.html?library=' + library.token, count: library.count, updatedAt: library.updatedAt };
  }
  return { capture, status: () => request('GET'), publish: (payload, context) => request('PUT', payload, context), remove: context => request('DELETE', undefined, context) };
}
module.exports = { createSongRequestSharing };
