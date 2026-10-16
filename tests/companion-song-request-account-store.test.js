'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { createSongRequestAccountStore } = require('../companion/song-request-account-store.cjs');

const credentials = (changes = {}) => ({
  accessToken: 'private-access-token-fixture', refreshToken: 'private-refresh-token-fixture', expiresAt: 2000000000000,
  clientId: 'Client123', userId: '1234567', login: 'fixture_streamer', displayName: 'Fixture Streamer',
  scopes: ['user:read:chat', 'user:write:chat'], ...changes
});
const safeFailure = code => error => error.code === 'SONG_REQUEST_ACCOUNT_STORE_SAFE'
  && (!code || error.reason === code) && !/private|Fixture|token-fixture|profile/i.test(error.message);

// Synthetic OS-encryption substitute with authenticated ciphertext, never production account values.
function encryption() {
  const key = randomBytes(32);
  const control = { available: true, backend: 'fixture', encryptCalls: 0, decryptCalls: 0, failEncrypt: false };
  const safeStorage = {
    isEncryptionAvailable: () => control.available,
    getSelectedStorageBackend: () => control.backend,
    encryptString(value) {
      control.encryptCalls++;
      if (control.failEncrypt) throw Error('private encryption failure');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      control.decryptCalls++;
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
  return { control, safeStorage };
}
async function fixture(t, { createDirectory = true, ...options } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-request-accounts-'));
  const dataDirectory = path.join(base, 'Private-profile');
  if (createDirectory) await fs.mkdir(dataDirectory);
  const crypto = encryption(), services = [];
  const fresh = (safeStorage = crypto.safeStorage, directory = dataDirectory) => {
    const service = createSongRequestAccountStore({ dataDirectory: directory, safeStorage }); services.push(service); return service;
  };
  const service = fresh(options.safeStorage ?? crypto.safeStorage);
  t.after(async () => {
    await Promise.all(services.map(value => value.flush()));
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-request-accounts-')) throw Error('Unexpected account fixture path');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDirectory, file: path.join(dataDirectory, 'song-request-accounts.enc'), service, fresh, ...crypto };
}

test('load alone creates no account file, and a credential is persisted only as authenticated ciphertext', async t => {
  const f = await fixture(t, { createDirectory: false });
  assert.equal(await f.service.load(), undefined); assert.equal(f.service.get('twitch'), null);
  await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  await f.service.set('twitch', credentials()); await f.service.flush();
  const bytes = await fs.readFile(f.file);
  for (const text of ['private-access-token-fixture', 'private-refresh-token-fixture', 'fixture_streamer', 'accessToken', 'version']) assert.equal(bytes.includes(Buffer.from(text)), false);
  assert.deepEqual(JSON.parse(f.safeStorage.decryptString(bytes)), { version: 1, accounts: { twitch: credentials() } });
  assert.deepEqual(f.service.status(), { persistent: true, error: null });
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-accounts.enc']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('a fresh service reloads the encrypted account and removal writes an encrypted empty document', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials());
  const fresh = f.fresh(); await fresh.load(); assert.deepEqual(fresh.get('twitch'), credentials());
  await fresh.set('twitch', null);
  const after = f.fresh(); await after.load(); assert.equal(after.get('twitch'), null);
  assert.deepEqual(JSON.parse(f.safeStorage.decryptString(await fs.readFile(f.file))), { version: 1, accounts: {} });
  assert.deepEqual(after.status(), { persistent: true, error: null });
});

test('inputs and returned credentials are independent copies and queued writes are drained in order', async t => {
  const f = await fixture(t), input = credentials();
  const first = f.service.set('twitch', input); input.accessToken = 'changed'; input.scopes.push('changed:scope');
  await first;
  const result = f.service.get('twitch'); result.accessToken = 'modified'; result.scopes.length = 0;
  assert.deepEqual(f.service.get('twitch'), credentials());
  const writes = Promise.all([f.service.set('twitch', credentials({ accessToken: 'second' })), f.service.set('twitch', credentials({ accessToken: 'third' }))]);
  await f.service.flush(); await writes;
  const fresh = f.fresh(); await fresh.load(); assert.equal(fresh.get('twitch').accessToken, 'third');
  assert.deepEqual(Object.keys(f.service.status()).sort(), ['error', 'persistent']);
  assert.doesNotMatch(JSON.stringify(f.service.status()), /accessToken|refreshToken|Client123|fixture_streamer/);
});

test('unavailable encryption uses session memory and does not create directories or call encrypt/decrypt', async t => {
  const f = await fixture(t, { createDirectory: false }); f.control.available = false;
  await f.service.load(); await f.service.set('twitch', credentials());
  assert.deepEqual(f.service.get('twitch'), credentials());
  assert.deepEqual(f.service.status(), { persistent: false, error: 'encryption_unavailable' });
  assert.equal(f.control.encryptCalls, 0); assert.equal(f.control.decryptCalls, 0);
  await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  await f.service.set('twitch', null); assert.equal(f.service.get('twitch'), null);
});

test('basic_text and missing or throwing encryption APIs never persist plaintext', async t => {
  const f = await fixture(t);
  f.control.backend = 'basic_text';
  for (const unavailable of [f.safeStorage, undefined, {}, { isEncryptionAvailable: () => { throw Error('private OS error'); } },
    { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('plaintext') }]) {
    const service = f.fresh(unavailable); await service.load(); await service.set('twitch', credentials());
    assert.deepEqual(service.status(), { persistent: false, error: 'encryption_unavailable' });
    assert.deepEqual(service.get('twitch'), credentials());
  }
  assert.deepEqual(await fs.readdir(f.dataDirectory), []);
  assert.equal(f.control.encryptCalls, 0); assert.equal(f.control.decryptCalls, 0);
});

test('session-only mode preserves a previous encrypted account and never starts writing if encryption later appears', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials()); const original = await fs.readFile(f.file);
  f.control.available = false; const session = f.fresh(); await session.load(); assert.equal(session.get('twitch'), null);
  const decryptedBefore = f.control.decryptCalls;
  await session.set('twitch', credentials({ accessToken: 'session-only' }));
  f.control.available = true; await session.set('twitch', null);
  assert.equal(f.control.decryptCalls, decryptedBefore); assert.deepEqual(await fs.readFile(f.file), original);
  assert.deepEqual(session.status(), { persistent: false, error: 'encryption_unavailable' });
  const fresh = f.fresh(); await fresh.load(); assert.deepEqual(fresh.get('twitch'), credentials());
});

test('loss of OS encryption after load falls back to memory without overwriting the prior encrypted document', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials()); const original = await fs.readFile(f.file);
  f.control.available = false; await f.service.set('twitch', credentials({ accessToken: 'session-update' }));
  assert.equal(f.service.get('twitch').accessToken, 'session-update');
  assert.deepEqual(f.service.status(), { persistent: false, error: 'encryption_unavailable' });
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('corrupt, future, oversized and invalid-schema files are protected and never expose partial accounts', async t => {
  const f = await fixture(t);
  const invalid = [Buffer.from('private broken ciphertext'), Buffer.alloc(65537, 1),
    ...[{ version: 2, accounts: { twitch: credentials() } }, { version: 1, accounts: { twitch: credentials({ scopes: ['valid', 'valid'] }) } },
      { version: 1, accounts: { twitch: credentials(), tiktok: {} } }, { version: 1, accounts: { twitch: credentials() }, extra: true }]
      .map(value => f.safeStorage.encryptString(JSON.stringify(value))),
    f.safeStorage.encryptString('{ broken private JSON'), f.safeStorage.encryptString(' '.repeat(32769))];
  for (const [index, original] of invalid.entries()) {
    await fs.writeFile(f.file, original); const service = f.fresh(); await service.load();
    assert.equal(service.get('twitch'), null);
    assert.deepEqual(service.status(), { persistent: false, error: index === 2 ? 'future_version' : 'unreadable' });
    await assert.rejects(service.set('twitch', credentials()), safeFailure());
    await assert.rejects(service.set('twitch', null), safeFailure());
    assert.deepEqual(await fs.readFile(f.file), original);
  }
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-accounts.enc']);
});

test('external file replacement, even with identical bytes, permanently blocks a stale writer', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials()); const original = await fs.readFile(f.file);
  const backup = path.join(f.dataDirectory, 'original.enc'); await fs.rename(f.file, backup); await fs.writeFile(f.file, original);
  await assert.rejects(f.service.set('twitch', credentials({ accessToken: 'new' })), safeFailure('changed'));
  assert.deepEqual(f.service.get('twitch'), credentials()); assert.equal(f.service.status().persistent, false);
  assert.deepEqual(await fs.readFile(f.file), original); assert.deepEqual(await fs.readFile(backup), original);
  await fs.unlink(f.file); await fs.rename(backup, f.file);
  await assert.rejects(f.service.set('twitch', null), safeFailure('changed'));
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('external deletion is not resurrected and a replaced profile directory does not receive stale credentials', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials());
  await fs.unlink(f.file); await assert.rejects(f.service.set('twitch', credentials()), safeFailure('changed'));
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const fresh = f.fresh(); await fresh.set('twitch', credentials()); const original = await fs.readFile(f.file);
  const backup = path.join(f.base, 'backup'); await fs.rename(f.dataDirectory, backup); await fs.mkdir(f.dataDirectory);
  await assert.rejects(fresh.set('twitch', credentials({ accessToken: 'replacement' })), safeFailure('changed'));
  assert.deepEqual(await fs.readdir(f.dataDirectory), []);
  assert.deepEqual(await fs.readFile(path.join(backup, 'song-request-accounts.enc')), original);
});

test('a competing account writer is detected and an occupied lock is preserved without replacing credentials', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials());
  const other = f.fresh(); await other.load();
  const lock = path.join(f.dataDirectory, '.song-request-accounts.lock'); await fs.writeFile(lock, 'private lock owner');
  const before = await fs.readFile(f.file);
  await assert.rejects(other.set('twitch', credentials({ accessToken: 'second' })), safeFailure('write_failed'));
  assert.equal(await fs.readFile(lock, 'utf8'), 'private lock owner'); assert.deepEqual(await fs.readFile(f.file), before);
  await fs.unlink(lock); await other.set('twitch', credentials({ accessToken: 'second' }));
  const updated = await fs.readFile(f.file);
  await assert.rejects(f.service.set('twitch', null), safeFailure('changed'));
  assert.deepEqual(await fs.readFile(f.file), updated); assert.deepEqual(other.get('twitch'), credentials({ accessToken: 'second' }));
});

test('encryption failures preserve the previous credential and disk bytes and allow a later explicit retry', async t => {
  const f = await fixture(t); await f.service.set('twitch', credentials()); const before = await fs.readFile(f.file);
  f.control.failEncrypt = true; await assert.rejects(f.service.set('twitch', credentials({ accessToken: 'failed' })), safeFailure('write_failed'));
  assert.deepEqual(f.service.get('twitch'), credentials()); assert.deepEqual(await fs.readFile(f.file), before);
  f.control.failEncrypt = false; await f.service.set('twitch', credentials({ refreshToken: null }));
  assert.equal(f.service.status().error, null); assert.equal(f.service.get('twitch').refreshToken, null);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-accounts.enc']);
});

test('invalid credentials, providers and non-absolute paths are rejected before any account write', async t => {
  const f = await fixture(t);
  const invalid = [undefined, {}, [], { ...credentials(), path: 'private' },
    ...[{ accessToken: '' }, { accessToken: 'unsafe\nline' }, { refreshToken: undefined }, { expiresAt: -1 }, { expiresAt: Infinity },
      { clientId: 'client/secret' }, { userId: 'viewer-name' }, { login: 'UpperCase' }, { displayName: 'bad\nname' },
      { scopes: ['chat:read', 'chat:read'] }, { scopes: ['bad scope'] }, { scopes: Array.from({ length: 33 }, (_, index) => 'scope' + index) }]
      .map(patch => credentials(patch))];
  for (const input of invalid) await assert.rejects(f.service.set('twitch', input), safeFailure('invalid_credential'));
  await assert.rejects(f.service.set('tiktok', credentials()), safeFailure());
  assert.throws(() => f.service.get('tiktok'), safeFailure('invalid_provider'));
  assert.deepEqual(await fs.readdir(f.dataDirectory), []);
  for (const dataDirectory of ['', '.', '../private', 'relative', path.join(f.base, 'bad\0profile')]) {
    assert.throws(() => createSongRequestAccountStore({ dataDirectory, safeStorage: f.safeStorage }), safeFailure('invalid_directory'));
  }
});

test('a directory at the account filename is protected and never removed', async t => {
  const f = await fixture(t); await fs.mkdir(f.file); await fs.writeFile(path.join(f.file, 'private.txt'), 'untouched');
  await f.service.load(); assert.deepEqual(f.service.status(), { persistent: false, error: 'unreadable' });
  await assert.rejects(f.service.set('twitch', credentials()), safeFailure('unreadable'));
  assert.equal(await fs.readFile(path.join(f.file, 'private.txt'), 'utf8'), 'untouched');
});
