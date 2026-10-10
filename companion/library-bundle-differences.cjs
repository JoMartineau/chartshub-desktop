'use strict';

const HASH = /^[a-f0-9]{64}$/;
const CATEGORY_ORDER = ['notes', 'audio', 'artwork', 'metadata', 'other'];
const countKey = { identical: 'identical', changed: 'changed', 'only-keeper': 'onlyKeeper', 'only-copy': 'onlyCopy', unverified: 'unverified' };
const safeBytes = value => Number.isSafeInteger(value) && value >= 0;
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 32768
  && !/[\\<>:"|?*\u0000-\u001f\u007f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
const key = name => name.normalize('NFC').toLowerCase();
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function category(name) {
  if (/\.(?:chart|mid|midi)$/i.test(name)) return 'notes';
  if (/\.(?:ogg|opus|mp3|wav|flac|aiff?|m4a)$/i.test(name)) return 'audio';
  if (/\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|svg)$/i.test(name)) return 'artwork';
  if (/\.(?:ini|json|ya?ml|xml)$/i.test(name)) return 'metadata';
  return 'other';
}
function manifest(bundle) {
  if (bundle?.status !== 'verified' || !['folder', 'sng'].includes(bundle.kind) || !Array.isArray(bundle.files)
    || !Number.isSafeInteger(bundle.entryCount) || bundle.entryCount !== bundle.files.length) return null;
  const entries = new Map();
  for (const file of bundle.files) {
    if (!file || !safeName(file.name) || !safeBytes(file.bytes) || !HASH.test(file.sha256) || entries.has(key(file.name))) return null;
    entries.set(key(file.name), { name: file.name, bytes: file.bytes, sha256: file.sha256, category: category(file.name) });
  }
  if (bundle.kind === 'sng') {
    if (!bundle.containerMetadata || !safeBytes(bundle.containerMetadata.bytes) || !HASH.test(bundle.containerMetadata.sha256)) return null;
    entries.set('sng: metadata', { ...bundle.containerMetadata, name: 'SNG: metadata', category: 'metadata' });
  }
  return entries;
}

/** A renderer-safe description only. It grants no cleanup permission and
 * never treats an unreadable manifest as evidence that a file is absent. */
function describeBundleDifferences(keeperBundle, candidateBundle) {
  const keeper = manifest(keeperBundle), copy = manifest(candidateBundle);
  const verified = keeper !== null && copy !== null;
  const counts = { identical: 0, changed: 0, onlyKeeper: 0, onlyCopy: 0, unverified: 0 }, files = [];
  const names = new Set([...(keeper?.keys() ?? []), ...(copy?.keys() ?? [])]);
  for (const name of names) {
    const left = keeper?.get(name), right = copy?.get(name);
    const status = !verified ? 'unverified' : !left ? 'only-copy' : !right ? 'only-keeper'
      : left.name === right.name && left.bytes === right.bytes && left.sha256 === right.sha256 ? 'identical' : 'changed';
    files.push({ name: left?.name ?? right.name, category: left?.category ?? right.category, status,
      keeperBytes: left?.bytes ?? null, copyBytes: right?.bytes ?? null });
  }
  // Equal decoded files do not prove equal archives: masking, file ordering,
  // metadata encoding and other container bytes remain relevant to cleanup.
  if (verified && keeperBundle.kind === 'sng' && candidateBundle.kind === 'sng'
    && HASH.test(keeperBundle.bundleHash) && HASH.test(candidateBundle.bundleHash)
    && keeperBundle.bundleHash !== candidateBundle.bundleHash && files.every(file => file.status === 'identical')) {
    files.push({ name: 'SNG: container', category: 'other', status: 'changed',
      keeperBytes: safeBytes(keeperBundle.totalBytes) ? keeperBundle.totalBytes : null,
      copyBytes: safeBytes(candidateBundle.totalBytes) ? candidateBundle.totalBytes : null });
  }
  files.sort((left, right) => CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
    || order(key(left.name), key(right.name)) || order(left.name, right.name));
  for (const file of files) counts[countKey[file.status]]++;
  return { status: verified ? 'verified' : 'unavailable', counts, files };
}

module.exports = { describeBundleDifferences };
