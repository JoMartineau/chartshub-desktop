'use strict';

const ORIGIN = 'https://rhythmverse.co';
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_DIMENSION = 2048;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const MAX_PENDING = 64;
const MAX_ACTIVE = 6;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function rhythmVerseArtworkUrl(value, base = ORIGIN) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\s\u0000-\u001f\u007f]/u.test(value) || value.startsWith('//')) return null;
  try {
    const url = new URL(value, base);
    const filename = decodeURIComponent(url.pathname);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
      || /%2f|%5c/i.test(url.pathname) || !/^\/assets\/album_art\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_. -]+\.(?:png|jpe?g|webp)$/iu.test(filename)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const bounded = (width, height) => width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;

function jpegIsBounded(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (JPEG_FRAMES.has(marker)) return length >= 8 && bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    offset += length;
  }
  return false;
}

function webpIsBounded(bytes) {
  if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  const chunk = bytes.toString('ascii', 12, 16);
  const length = bytes.readUInt32LE(16);
  if (length + 20 > bytes.length) return false;
  if (chunk === 'VP8X' && length >= 10) return !(bytes[20] & 2) && bounded(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  if (chunk === 'VP8L' && length >= 5 && bytes[20] === 0x2f) {
    const size = bytes.readUInt32LE(21);
    return bounded((size & 0x3fff) + 1, ((size >>> 14) & 0x3fff) + 1);
  }
  return chunk === 'VP8 ' && length >= 10 && bytes.readUIntBE(23, 3) === 0x9d012a
    && bounded(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG) && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && jpegIsBounded(bytes)) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && webpIsBounded(bytes)) return 'image/webp';
  return null;
}

function cancelBody(body) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

async function fetchArtwork(fetchImpl, url, signal) {
  const visited = new Set();
  for (let hops = 0; hops <= 2 && url && !visited.has(url); hops++) {
    signal.throwIfAborted();
    visited.add(url);
    const response = await fetchImpl(url, {
      credentials: 'omit', redirect: 'manual', signal,
      headers: { Accept: 'image/png, image/jpeg, image/webp' }
    });
    if (REDIRECTS.has(response.status)) {
      const next = response.headers.get('location');
      cancelBody(response.body);
      url = rhythmVerseArtworkUrl(next, url);
      continue;
    }
    const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const declared = Number(response.headers.get('content-length'));
    if (!response.ok || response.redirected || (response.url && response.url !== url) || !response.body
      || !IMAGE_TYPES.has(mime) || declared > MAX_IMAGE_BYTES) {
      cancelBody(response.body);
      return null;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) return null;
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    // RhythmVerse can label JPEG bytes as image/png on a .png cover URL.
    const type = imageType(bytes);
    return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
  }
  return null;
}

function createRhythmVerseArtwork({ fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0, cacheBytes = 0;

  function drop(url) {
    const stored = cache.get(url);
    if (!stored) return;
    cache.delete(url);
    cacheBytes -= stored.src?.length || 0;
  }

  function store(url, src) {
    drop(url);
    cache.set(url, { src, expires: Date.now() + (src ? 30 * 60_000 : 20_000) });
    cacheBytes += src?.length || 0;
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) drop(cache.keys().next().value);
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      const task = queue.shift();
      active++;
      const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(8_000)]);
      void fetchArtwork(fetchImpl, task.url, signal).catch(() => null).then(src => {
        if (pending.get(task.url) !== task) return;
        pending.delete(task.url);
        store(task.url, src);
        task.resolve(src);
      }).finally(() => { active--; pump(); });
    }
  }

  function abandon(task) {
    if (pending.get(task.url) !== task) return;
    pending.delete(task.url);
    const position = queue.indexOf(task);
    if (position !== -1) queue.splice(position, 1);
    task.controller.abort();
    task.resolve(null);
  }

  async function load(value, { signal } = {}) {
    const url = rhythmVerseArtworkUrl(value);
    if (!url || signal?.aborted) return null;
    const stored = cache.get(url);
    if (stored && stored.expires > Date.now()) {
      cache.delete(url);
      cache.set(url, stored);
      return stored.src;
    }
    drop(url);
    let task = pending.get(url);
    if (!task) {
      if (pending.size >= MAX_PENDING) return null;
      task = { url, controller: new AbortController(), waiters: 0 };
      task.promise = new Promise(resolve => { task.resolve = resolve; });
      pending.set(url, task);
      queue.push(task);
    }
    task.waiters++;
    const outcome = !signal ? task.promise : new Promise(resolve => {
      const abort = () => {
        if (--task.waiters === 0) abandon(task);
        resolve(null);
      };
      signal.addEventListener('abort', abort, { once: true });
      task.promise.then(src => {
        signal.removeEventListener('abort', abort);
        resolve(signal.aborted ? null : src);
      });
    });
    pump();
    return outcome;
  }

  function clear() {
    for (const task of pending.values()) {
      task.controller.abort();
      task.resolve(null);
    }
    pending.clear();
    queue.length = 0;
    cache.clear();
    cacheBytes = 0;
  }

  return { load, clear };
}

module.exports = { createRhythmVerseArtwork, rhythmVerseArtworkUrl };
