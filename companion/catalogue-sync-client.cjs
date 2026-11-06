'use strict';

const ORIGIN = 'https://chartshub.ca';
const ENDPOINT = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TOTAL = 200000, PAGE_SIZE = 500, MAX_BYTES = 2 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function syncError(code) { return Object.assign(Error(code), { code }); }
function validateDescriptor(row) {
  if (!object(row) || typeof row.endpoint !== 'string' || !ENDPOINT.test(row.endpoint)
      || !['chartId', 'title', 'artist', 'charter'].every(key => typeof row[key] === 'string' && row[key].length <= 512)
      || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(row.chartId)
      || !(row.contentRevision === null || typeof row.contentRevision === 'string' && HASH.test(row.contentRevision))
      || !['content', 'version', 'manifest-required'].includes(row.verification)
      || !(row.files === null || Number.isSafeInteger(row.files) && row.files > 0 && row.files <= 1000)
      || !(row.totalBytes === null || Number.isSafeInteger(row.totalBytes) && row.totalBytes >= 0)
      || row.contentRevision === null && row.verification !== 'manifest-required') throw syncError('SYNC_INVALID');
  const clean = value => value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return { chartId: row.chartId, title: clean(row.title), artist: clean(row.artist), charter: clean(row.charter), endpoint: row.endpoint,
    contentRevision: row.contentRevision, verification: row.verification, files: row.files, totalBytes: row.totalBytes };
}
function createCatalogueSyncClient({ fetcher = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw syncError('SYNC_INVALID');
  async function page({ offset = 0, revision = null, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TOTAL || !(revision === null || HASH.test(revision))) throw syncError('SYNC_INVALID');
    const controller = new AbortController(), relay = () => controller.abort();
    signal?.throwIfAborted(); signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(relay, timeoutMs);
    const aborted = new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(syncError('SYNC_TIMEOUT')), { once: true }));
    aborted.catch(() => {});
    const wait = value => Promise.race([value, aborted]);
    let reader;
    try {
      const url = `${ORIGIN}/api/catalogue-sync?offset=${offset}&limit=${PAGE_SIZE}${revision ? '&revision=' + revision : ''}`;
      const response = await wait(fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal }));
      if (response?.status === 409) throw syncError('SYNC_CATALOGUE_CHANGED');
      if (response?.status === 404) throw syncError('SYNC_SERVER_UPDATE_REQUIRED');
      if (response?.status !== 200 || response.redirected || response.url && response.url !== url) throw syncError('SYNC_NETWORK');
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body?.getReader) throw syncError('SYNC_INVALID');
      reader = response.body.getReader(); let bytes = 0; const chunks = [];
      for (;;) { const value = await wait(reader.read()); if (value.done) break; bytes += value.value.length; if (bytes > MAX_BYTES) throw syncError('SYNC_INVALID'); chunks.push(Buffer.from(value.value)); }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw syncError('SYNC_INVALID'); }
      if (!object(data) || !HASH.test(data.revision) || revision && revision !== data.revision || data.offset !== offset
          || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > MAX_TOTAL || !Array.isArray(data.items) || data.items.length > PAGE_SIZE
          || offset + data.items.length > data.total || !(data.nextOffset === null ? offset + data.items.length === data.total
            : data.nextOffset === offset + data.items.length && data.nextOffset < data.total && data.items.length > 0)) throw syncError('SYNC_INVALID');
      const items = data.items.map(validateDescriptor);
      if (new Set(items.map(item => item.endpoint)).size !== items.length) throw syncError('SYNC_INVALID');
      return { revision: data.revision, total: data.total, offset, nextOffset: data.nextOffset, items };
    } catch (problem) {
      if (signal?.aborted) throw Object.assign(Error('Cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (/^SYNC_/.test(problem?.code)) throw problem;
      throw syncError(controller.signal.aborted ? 'SYNC_TIMEOUT' : 'SYNC_NETWORK');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); void reader?.cancel().catch(() => {}); }
  }
  return { page };
}
module.exports = { createCatalogueSyncClient, validateDescriptor, ENDPOINT, HASH, PAGE_SIZE, MAX_TOTAL, syncError };
