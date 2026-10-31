'use strict';
// Pinned bytes only. Parsing happens in memory; archive paths never become paths on disk.
const fs = require('node:fs/promises'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const LOADER = Object.freeze({ version: '0.7.3', url: 'https://github.com/LavaGang/MelonLoader/releases/download/v0.7.3/MelonLoader.x64.zip', bytes: 20155622, sha256: '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416' });
const MODULE = Object.freeze({ version: '0.2.2', bytes: 108032, sha256: '1244a2b0ccd14b54259b442253313f59ce731fb1a7e2bf5e504f1329aa99a811' });
const GAME = Object.freeze({ version: '1.1.0.6142', gameAssemblySha256: '12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197', metadataSha256: '5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42' });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(Error('PAYLOAD_INVALID'), { code: 'PAYLOAD_INVALID' }); };
function relative(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 220 || /[\\:\x00-\x1f\x7f<>"|?*]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail();
    return value;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function readZip(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 24 * 1024 * 1024) fail();
    let end = -1;
    for (let n = bytes.length - 22; n >= Math.max(0, bytes.length - 65557); n--) if (bytes.readUInt32LE(n) === 0x06054b50 && n + 22 + bytes.readUInt16LE(n + 20) === bytes.length) { end = n; break; }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
    const count = bytes.readUInt16LE(end + 10), centralBytes = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
    if (!count || count > 500 || count !== bytes.readUInt16LE(end + 8) || centralStart + centralBytes !== end) fail();
    const files = new Map(), names = new Set(), ranges = []; let at = centralStart, total = 0;
    for (let i = 0; i < count; i++) {
        if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
        const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), attributes = bytes.readUInt32LE(at + 38), offset = bytes.readUInt32LE(at + 42);
        if (flags & ~0x808 || ![0, 8].includes(method) || size > 32 * 1024 * 1024 || packed > 24 * 1024 * 1024 || at + 46 + nameLength + extra + comment > end || bytes.readUInt16LE(at + 34)) fail();
        const unixType = (attributes >>> 16) & 0xf000;
        if (unixType && ![0x8000, 0x4000].includes(unixType)) fail();
        const rawName = bytes.subarray(at + 46, at + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(rawName), directory = name.endsWith('/'), safe = relative(directory ? name.slice(0, -1) : name);
        if (!(safe === 'version.dll' || safe === 'MelonLoader' || safe.startsWith('MelonLoader/')) || names.has(safe.toLowerCase()) || (directory && size !== 0)) fail();
        names.add(safe.toLowerCase()); total += size; if (total > 128 * 1024 * 1024 || offset + 30 > centralStart || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail();
        const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), start = offset + 30 + localName + localExtra;
        if (start + packed > centralStart || !bytes.subarray(offset + 30, offset + 30 + localName).equals(rawName)) fail();
        if (!(flags & 8) && (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== packed || bytes.readUInt32LE(offset + 22) !== size)) fail();
        ranges.push([offset, start + packed]); const compressed = bytes.subarray(start, start + packed);
        const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
        if (data.length !== size || crc32(data) !== crc) fail();
        if (!directory) files.set(safe, data); at += 46 + nameLength + extra + comment;
    }
    if (at !== end) fail(); ranges.sort((a, b) => a[0] - b[0]); for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail();
    if (!files.has('version.dll') || !files.has('MelonLoader/net6/MelonLoader.dll')) fail(); return files;
}
async function loadRelease(directory = path.join(__dirname, 'connector-assets')) {
    const raw = await fs.readFile(path.join(directory, 'manifest.json')); if (raw.length > 128 * 1024) fail(); const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (manifest.version !== 1 || manifest.loader?.sha256 !== LOADER.sha256 || manifest.loader?.bytes !== LOADER.bytes || manifest.loader?.url !== LOADER.url || manifest.module?.sha256 !== MODULE.sha256 || manifest.module?.bytes !== MODULE.bytes || manifest.game?.gameAssemblySha256 !== GAME.gameAssemblySha256 || manifest.game?.metadataSha256 !== GAME.metadataSha256 || !Array.isArray(manifest.files) || manifest.files.length !== 164) fail();
    const module = await fs.readFile(path.join(directory, 'ChartsHub.CloneHero.Telemetry.dll')); if (module.length !== MODULE.bytes || sha(module) !== MODULE.sha256) fail();
    const seen = new Set(); for (const f of manifest.files) { relative(f.path); if (!(f.path === 'version.dll' || f.path.startsWith('MelonLoader/')) || seen.has(f.path.toLowerCase()) || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256)) fail(); seen.add(f.path.toLowerCase()); }
    return { ...manifest, moduleBytes: module };
}
function verifyArchive(bytes, release) {
    if (bytes.length !== release.loader.bytes || sha(bytes) !== release.loader.sha256) fail(); const entries = readZip(bytes);
    if (entries.size !== release.files.length) fail(); for (const f of release.files) { const data = entries.get(f.path); if (!data || data.length !== f.bytes || sha(data) !== f.sha256) fail(); }
    const module = Buffer.from(release.moduleBytes); if (module.length !== release.module.bytes || sha(module) !== release.module.sha256) fail(); entries.set('Mods/ChartsHub.CloneHero.Telemetry.dll', module); return entries;
}
module.exports = { LOADER, MODULE, GAME, relative, sha, crc32, readZip, loadRelease, verifyArchive };
