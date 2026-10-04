'use strict';

const ENTITIES = Object.freeze({ amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' });
const FORMATTING = /<\/?(?:a|b|br|div|em|font|i|p|s|small|span|strong|sub|sup|u)(?:\s+[^<>]*)?\s*\/?>/gi;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Conservative equivalence only: keep every word, including release/version qualifiers. */
function normalizeMetadata(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|apos|quot|lt|gt|nbsp);/gi, (original, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? original;
    const number = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : original;
  }).replace(FORMATTING, ' ').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’‘ʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function metadata(record) {
  return { title: normalizeMetadata(record?.title), artist: normalizeMetadata(record?.artist), charter: normalizeMetadata(record?.charter) };
}

function classifyMatch(local, remote) {
  const installed = metadata(local), candidate = metadata(remote);
  if (!installed.title || !installed.artist || !candidate.title || !candidate.artist) {
    return { kind: 'none', reason: 'Titre ou artiste manquant : aucun rapprochement fiable.' };
  }
  if (installed.title !== candidate.title || installed.artist !== candidate.artist) {
    return { kind: 'none', reason: 'Le titre et l’artiste ne concordent pas exactement.' };
  }
  if (installed.charter && candidate.charter && installed.charter === candidate.charter) {
    return { kind: 'suggested', reason: 'Titre, artiste et charter concordent ; suggestion à confirmer.' };
  }
  return { kind: 'possible', reason: installed.charter && candidate.charter
    ? 'Titre et artiste concordent, mais le charter diffère ; rapprochement à confirmer.'
    : 'Titre et artiste concordent, mais le charter est incomplet ; rapprochement à confirmer.' };
}

/** Keep duplicates visible; a metadata match never establishes chart identity or verification. */
function findMatches(local, remotes) {
  const matches = [];
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    const match = classifyMatch(local, remote);
    if (match.kind !== 'none') matches.push({ remote, ...match, ambiguous: false });
  }
  matches.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'suggested' ? -1 : 1;
    for (const field of ['title', 'artist', 'charter']) {
      const result = compare(normalizeMetadata(left.remote?.[field]), normalizeMetadata(right.remote?.[field]));
      if (result) return result;
    }
    return compare(String(left.remote?.id ?? ''), String(right.remote?.id ?? ''));
  });
  if (matches.length > 1) for (const match of matches) {
    match.ambiguous = true;
    match.reason += ' Plusieurs charts correspondent à ces métadonnées.';
  }
  return matches;
}

function lookupKey(value) {
  const { title, artist } = metadata(value);
  return title && artist ? JSON.stringify([title, artist]) : null;
}

/** Build anew for the current library snapshot; IDs alone are not portable across roots. */
function buildInstalledLookup(locals) {
  const lookup = new Map();
  for (const local of Array.isArray(locals) ? locals : []) {
    if (typeof local?.id !== 'string' || !local.id) continue;
    const key = lookupKey(local);
    if (key === null) continue;
    let items = lookup.get(key);
    if (!items) { items = []; lookup.set(key, items); }
    items.push(Object.freeze({ id: local.id, title: local.title, artist: local.artist, charter: local.charter }));
  }
  return lookup;
}

function annotateInstalled(remote, lookup) {
  const key = lookupKey(remote);
  const candidates = key !== null && lookup instanceof Map ? lookup.get(key) ?? [] : [];
  if (!candidates.length) return { status: 'none', localIds: [], reason: key === null
    ? 'Titre ou artiste manquant : installation non déterminée.'
    : 'Aucun candidat dans la bibliothèque pour ce titre et cet artiste.' };
  const localIds = [...new Set(candidates.map(local => local.id))].sort(compare);
  const charterAgrees = candidates.some(local => classifyMatch(local, remote).kind === 'suggested');
  const reason = candidates.length > 1
    ? 'Plusieurs entrées locales correspondent au titre et à l’artiste ; installation de ce chart à confirmer.'
    : charterAgrees
      ? 'Titre, artiste et charter concordent avec une entrée locale ; installation de ce chart à confirmer.'
      : 'Titre et artiste concordent avec une entrée locale ; installation de ce chart à confirmer.';
  return { status: 'candidate', localIds, reason };
}

module.exports = { normalizeMetadata, classifyMatch, findMatches, buildInstalledLookup, annotateInstalled };
