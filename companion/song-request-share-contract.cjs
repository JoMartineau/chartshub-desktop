'use strict';
const MAX_SONGS = 200000, MAX_BYTES = 128 * 1024 * 1024, BATCH_SIZE = 500, BATCH_BYTES = 768 * 1024;
const SHARE_ERRORS = Object.freeze(['SHARE_ACCOUNT_REQUIRED', 'SHARE_ACCOUNT_UNVERIFIED', 'SHARE_ACCOUNT_CHANGED', 'SHARE_ACCESS_DENIED',
  'SHARE_LIBRARY_NOT_READY', 'SHARE_LIBRARY_EMPTY', 'SHARE_LIBRARY_CHANGED', 'SHARE_LIBRARY_LIMIT', 'SHARE_METADATA_LIMIT',
  'SHARE_METADATA_INVALID', 'SHARE_SERVER_UPDATE_REQUIRED', 'SHARE_UPLOAD_CONFLICT', 'SHARE_RATE_LIMIT',
  'SHARE_NETWORK', 'SHARE_RESPONSE_INVALID', 'SHARE_UNAVAILABLE', 'SHARE_CANCELLED']);
function shareError(code) {
  return Object.assign(Error('Le partage est indisponible. Réessayez après avoir vérifié l’état indiqué.'), { code: SHARE_ERRORS.includes(code) ? code : 'SHARE_UNAVAILABLE' });
}
function shareErrorCode(failure) { return SHARE_ERRORS.includes(failure?.code) ? failure.code : 'SHARE_UNAVAILABLE'; }
module.exports = { MAX_SONGS, MAX_BYTES, BATCH_SIZE, BATCH_BYTES, SHARE_ERRORS, shareError, shareErrorCode };
