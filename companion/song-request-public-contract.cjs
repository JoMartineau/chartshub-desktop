'use strict';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SONG_ID = /^[a-f0-9]{64}$/;
const ACK_CODES = Object.freeze(['request_added', 'vote_added', 'disabled', 'not_found', 'cooldown', 'viewer_limit',
  'queue_full', 'duplicate_vote', 'duplicate_event', 'vote_limit', 'metadata_unknown', 'duration_limit',
  'instrument_unavailable', 'difficulty_unavailable', 'library_changed', 'song_unavailable',
  'library_unavailable', 'rate_limited', 'invalid_request', 'library_revision_changed']);
const MAX_EVENTS = 20;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isSongId = value => typeof value === 'string' && SONG_ID.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).length === expected.length
  && Object.keys(value).every(key => expected.includes(key));
function pollInput(value) {
  if (!keys(value, ['sessionId', 'receiving']) || !isUuid(value.sessionId) || typeof value.receiving !== 'boolean') throw TypeError('Invalid public request poll.');
  return { sessionId: value.sessionId, receiving: value.receiving };
}
function pollOutput(value, sessionId, receiving = true) {
  if (!keys(value, ['sessionId', 'libraryRevision', 'events']) || value.sessionId !== sessionId
      || (receiving ? !isUuid(value.libraryRevision) : value.libraryRevision !== null && !isUuid(value.libraryRevision))
      || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) throw TypeError('Invalid public request response.');
  if (!receiving && value.events.length) throw TypeError('A closed public request lease cannot deliver events.');
  const seen = new Set();
  const events = value.events.map(event => {
    if (!keys(event, ['id', 'libraryRevision', 'songId', 'viewerId', 'viewerName']) || !isUuid(event.id)
        || !isUuid(event.libraryRevision) || !isSongId(event.songId)
        || typeof event.viewerId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(event.viewerId)
        || event.viewerName !== 'Spectateur web' || seen.has(event.id)) throw TypeError('Invalid public request event.');
    seen.add(event.id);
    return { id: event.id, libraryRevision: event.libraryRevision, songId: event.songId,
      viewerId: event.viewerId, viewerName: event.viewerName };
  });
  return { sessionId, libraryRevision: value.libraryRevision, events };
}
function ackResult(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['id', 'ok', 'code', 'requestId', 'action'].includes(key))
      || !isUuid(value.id) || typeof value.ok !== 'boolean' || !ACK_CODES.includes(value.code)
      || (value.ok ? !isUuid(value.requestId) || !['request', 'vote'].includes(value.action)
        || value.code !== (value.action === 'request' ? 'request_added' : 'vote_added')
        : Object.hasOwn(value, 'requestId') || Object.hasOwn(value, 'action') || ['request_added', 'vote_added'].includes(value.code))) {
    throw TypeError('Invalid public request acknowledgement.');
  }
  return { id: value.id, ok: value.ok, code: value.code, ...(value.ok ? { requestId: value.requestId, action: value.action } : {}) };
}
function ackInput(value) {
  if (!keys(value, ['sessionId', 'results']) || !isUuid(value.sessionId) || !Array.isArray(value.results)
      || value.results.length < 1 || value.results.length > MAX_EVENTS) throw TypeError('Invalid public request acknowledgements.');
  const results = value.results.map(ackResult);
  if (new Set(results.map(item => item.id)).size !== results.length) throw TypeError('Duplicated public request acknowledgements.');
  return { sessionId: value.sessionId, results };
}
function ackOutput(value, input) {
  if (!keys(value, ['sessionId', 'acknowledged']) || value.sessionId !== input.sessionId || !Array.isArray(value.acknowledged)
      || value.acknowledged.length > input.results.length || new Set(value.acknowledged).size !== value.acknowledged.length
      || value.acknowledged.some(id => !input.results.some(result => result.id === id))) throw TypeError('Invalid public acknowledgement response.');
  return { sessionId: value.sessionId, acknowledged: [...value.acknowledged] };
}
module.exports = { UUID, SONG_ID, ACK_CODES, MAX_EVENTS, pollInput, pollOutput, ackInput, ackOutput };
