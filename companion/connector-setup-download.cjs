'use strict';
const https = require('node:https'), fs = require('node:fs'), fsp = require('node:fs/promises'), crypto = require('node:crypto'), { Transform } = require('node:stream'), { pipeline } = require('node:stream/promises');
const { LOADER } = require('./connector-setup-payload.cjs');
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function allowed(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443') && HOSTS.has(u.hostname); } catch { return false; } }
/** A fixed official release only. No cookies, account tokens or renderer URLs. */
async function downloadLoader(destination, { request = https.get, timeoutMs = 90000 } = {}) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs), requests = new Set(), responses = new Set(); let handle = null, owned = null, response = null, responseError = null;
    try {
        let url = LOADER.url;
        for (let redirects = 0; redirects <= 3; redirects++) {
            if (!allowed(url)) throw Error('DOWNLOAD_FAILED');
            responseError = null;
            response = await new Promise((resolve, reject) => { const req = request(url, { headers: { 'User-Agent': 'ChartsHub-Connector-Setup', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' }, signal: abort.signal }, value => { responses.add(value); value.on('error', error => { responseError = error; }); resolve(value); }); requests.add(req); req.once('error', reject); req.setTimeout?.(15000, () => req.destroy(Error('DOWNLOAD_FAILED'))); });
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) { const location = response.headers.location; response.destroy(); if (redirects === 3 || typeof location !== 'string') throw Error('DOWNLOAD_FAILED'); url = new URL(location, url).href; continue; }
            break;
        }
        if (response?.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || (response.headers['content-length'] !== undefined && Number(response.headers['content-length']) !== LOADER.bytes)) throw Error('DOWNLOAD_FAILED');
        let received = 0; const hash = crypto.createHash('sha256');
        const bound = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; if (received > LOADER.bytes) return callback(Error('DOWNLOAD_FAILED')); hash.update(chunk); callback(null, chunk); } });
        handle = await fsp.open(destination, 'wx', 0o600); owned = await handle.stat();
        if (abort.signal.aborted || responseError) throw Error('DOWNLOAD_FAILED');
        const output = handle.createWriteStream({ autoClose: true });
        await pipeline(response, bound, output, { signal: abort.signal });
        if (responseError || received !== LOADER.bytes || hash.digest('hex') !== LOADER.sha256) throw Error('DOWNLOAD_FAILED');
        const final = await fsp.lstat(destination); if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1 || final.ino !== owned.ino || final.dev !== owned.dev) throw Error('DOWNLOAD_FAILED');
        return { bytes: received, sha256: LOADER.sha256 };
    } catch (error) {
        response?.destroy();
        if (handle) { try { await handle.close(); } catch {} handle = null; }
        if (owned) try { const at = await fsp.lstat(destination); if (at.isFile() && !at.isSymbolicLink() && at.nlink === 1 && at.dev === owned.dev && at.ino === owned.ino) await fsp.unlink(destination); } catch { /* Only the exact file exclusively created by this operation may be removed. */ }
        throw Object.assign(Error('DOWNLOAD_FAILED'), { code: 'DOWNLOAD_FAILED', cause: error });
    } finally { abort.abort(); for (const value of responses) value.destroy(); for (const value of requests) value.destroy?.(); if (handle) try { await handle.close(); } catch {} clearTimeout(timer); }
}
module.exports = { allowed, downloadLoader };
