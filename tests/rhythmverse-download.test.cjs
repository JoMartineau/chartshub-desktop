'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canDownloadRhythmVerse, downloadRhythmVerseArchive, isRhythmVerseDriveFolder, downloadRhythmVerseDriveFolder } = require('../desktop/rhythmverse-download.cjs');

const drive = 'https://drive.google.com/file/d/Test_Chart-123/view?resourcekey=0-Example';
const rhythmVerse = 'https://rhythmverse.co/download_file/Test_Chart-123';
const payload = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

async function staged(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-rhythmverse-'));
  const filename = path.join(directory, 'chart.archive');
  t.after(async () => { await fs.rm(filename, { force: true }); await fs.rmdir(directory); });
  return filename;
}

test('recognizes only supported public archive and folder links', () => {
  assert.equal(canDownloadRhythmVerse(drive), true);
  assert.equal(canDownloadRhythmVerse(rhythmVerse), true);
  assert.equal(canDownloadRhythmVerse('https://drive.google.com/drive/u/0/folders/test'), true);
  assert.equal(isRhythmVerseDriveFolder('https://drive.google.com/drive/folders/test?resourcekey=0-Test'), true);
  for (const url of [
    'https://drive.google.com/drive/folders/test?resourcekey=..%2Ftest', 'https://mega.nz/file/test',
    'https://drive.google.com.evil.example/file/d/test', 'https://drive.google.com:4431/file/d/test',
    'http://drive.google.com/file/d/test', 'https://owner@drive.google.com/file/d/test',
    'https://drive.google.com/open?id=..%2fother', `${drive}%2F`, 'https://rhythmverse.co/songfile/test',
  ]) assert.equal(canDownloadRhythmVerse(url), false, url);
});

const driveFolder = 'https://drive.google.com/drive/folders/Root?resourcekey=0-Test';
const chartFiles = [['Notes', 'notes.chart'], ['Metadata', 'song.ini'], ['Song', 'song.ogg']];

function embedded(entries) {
  return `<div class="flip-entries">${entries.map(([id, name, folder]) => `
    <div class="flip-entry" id="entry-${id}" tabindex="0" role="link">
      <div class="flip-entry-info"><a href="https://drive.google.com/${folder ? `drive/folders/${id}` : `file/d/${id}/view`}">
        <div class="flip-entry-title">${name}</div></a></div></div>`).join('')}</div>`;
}

async function chartStage(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'chartshub-rhythmverse-folder-'));
  t.after(async () => {
    for (const filename of await fs.readdir(directory)) await fs.rm(path.join(directory, filename), { force: true });
    await fs.rmdir(directory);
  });
  return directory;
}

test('finds one nested chart, writes chart assets and honours the video preference', async t => {
  const directory = await chartStage(t);
  const calls = [];
  const actual = await downloadRhythmVerseDriveFolder({ url: driveFolder, directory, includeVideo: false, fetchImpl: async (url, init) => {
    assert.equal(init.credentials, 'omit');
    const target = new URL(url);
    const id = target.searchParams.get('id');
    calls.push(id);
    if (id === 'Root') {
      assert.equal(target.pathname, '/embeddedfolderview');
      assert.equal(target.searchParams.get('resourcekey'), '0-Test');
      return new Response(embedded([['Nested', 'My chart', true]]));
    }
    if (id === 'Nested') return new Response(embedded([...chartFiles, ['Video', 'video.mp4'], ['Executable', 'run.exe']]));
    return new Response('asset bytes', { headers: { 'content-type': id === 'Song' ? 'audio/ogg' : 'text/plain' } });
  } });
  assert.equal(actual, directory);
  assert.deepEqual(calls, ['Root', 'Nested', 'Notes', 'Metadata', 'Song']);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['notes.chart', 'song.ini', 'song.ogg']);
});

test('refuses unsafe or duplicate filenames and cleans partial folder downloads', async t => {
  const directory = await chartStage(t);
  for (const entries of [[...chartFiles, ['Unsafe', '../danger.ogg']], [...chartFiles, ['Duplicate', 'SONG.INI']]]) {
    const calls = [];
    await assert.rejects(downloadRhythmVerseDriveFolder({ url: driveFolder, directory, fetchImpl: async url => {
      calls.push(url); return new Response(embedded(entries));
    } }), { code: 'RV_ARCHIVE_DRIVE_FOLDER' });
    assert.equal(calls.length, 1);
  }
  await assert.rejects(downloadRhythmVerseDriveFolder({ url: driveFolder, directory, fetchImpl: async url => {
    const id = new URL(url).searchParams.get('id');
    if (id === 'Root') return new Response(embedded(chartFiles));
    if (id === 'Metadata') return new Response('<html>Private</html>', { headers: { 'content-type': 'text/html' } });
    return new Response('notes', { headers: { 'content-type': 'text/plain' } });
  } }), { code: 'RV_ARCHIVE_DRIVE_FOLDER' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('resolves a RhythmVerse redirect to Drive and streams the authorized archive', async t => {
  const filename = await staged(t);
  const calls = [];
  const result = await downloadRhythmVerseArchive({ url: rhythmVerse, filename, fetchImpl: async (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    calls.push(url);
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: drive } });
    return new Response(payload, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) } });
  } });
  assert.deepEqual(calls, [rhythmVerse, 'https://drive.usercontent.google.com/download?id=Test_Chart-123&export=download&confirm=t&resourcekey=0-Example']);
  assert.deepEqual(result, { bytes: payload.length });
  assert.deepEqual(await fs.readFile(filename), payload);
});

test('rejects unexpected hosts and HTML without saving anything', async t => {
  const filename = await staged(t);
  let count = 0;
  await assert.rejects(downloadRhythmVerseArchive({ url: drive, filename, fetchImpl: async () => {
    count++;
    return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/chart.zip' } });
  } }), { code: 'RV_ARCHIVE_REDIRECT' });
  assert.equal(count, 1);
  await assert.rejects(downloadRhythmVerseArchive({ url: drive, filename, fetchImpl: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) }), { code: 'RV_ARCHIVE_PAGE' });
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
});

test('removes a truncated partial transfer and preserves any existing target', async t => {
  const filename = await staged(t);
  await assert.rejects(downloadRhythmVerseArchive({ url: drive, filename, fetchImpl: async () => new Response(payload, { headers: { 'content-length': String(payload.length + 1) } }) }), { code: 'RV_ARCHIVE_TRUNCATED' });
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
  await fs.writeFile(filename, 'existing');
  await assert.rejects(downloadRhythmVerseArchive({ url: drive, filename, fetchImpl: async () => new Response(payload) }), { code: 'RV_ARCHIVE_FAILED' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'existing');
});
