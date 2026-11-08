'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { songFolderName } = require('../download.js');
const { prepareSavePath, publishSavedFile } = require('../enchor-download.js');
const { downloadRhythmVerseArchive, isRhythmVerseDriveFolder, downloadRhythmVerseDriveFolder } = require('./rhythmverse-download.cjs');
const { extractRhythmVerseArchive, writeRhythmVerseZip } = require('./rhythmverse-archive.cjs');
const { writeRhythmVerseSng } = require('./rhythmverse-sng.cjs');

const video = /^(?:video|background)\.(?:mp4|webm|avi|vp8|ogv|mpeg|mpg|mov|m4v|mkv|wmv)$/i;

function isChild(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function removeOwnedDirectory(root, directory, identity) {
  if (!directory) return;
  try {
    const real = await fs.realpath(directory);
    const stat = await fs.lstat(directory, { bigint: true });
    if (path.relative(real, directory) === '' && path.relative(root, path.dirname(real)) === ''
      && stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } catch { /* The directory was removed, moved or is no longer ours. */ }
}

async function removeVideos(directory, signal) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    signal.throwIfAborted();
    const target = path.join(directory, item.name);
    if (item.isDirectory()) await removeVideos(target, signal);
    else if (item.isFile() && video.test(item.name)) await fs.unlink(target);
  }
}

async function installRhythmVerseChart({ record, directory: exportDirectory, outputPath, format = 'folder', includeVideo = true, signal,
  download = downloadRhythmVerseArchive, extract = extractRhythmVerseArchive }) {
  if (!['folder', 'zip', 'sng'].includes(format)) throw Error('Format de téléchargement invalide.');
  const save = format === 'folder' ? null : await prepareSavePath(outputPath, format, true);
  const root = save?.root ?? await fs.realpath(exportDirectory);
  const rootIdentity = await fs.lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw Error('Choisissez un dossier d’exportation.');
  async function guardRoot() {
    const current = await fs.lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino
      || path.relative(root, await fs.realpath(root))) throw Error('Le dossier d’exportation a été déplacé.');
  }
  signal.throwIfAborted();

  const staging = await fs.mkdtemp(path.join(root, '.chartshub-partial-'));
  const stagingIdentity = await fs.lstat(staging, { bigint: true });
  let destination, destinationIdentity, complete = false;
  try {
    const archiveFile = path.join(staging, 'chart.archive');
    const directory = path.join(staging, 'extracted');
    await fs.mkdir(directory, { mode: 0o700 });
    let extracted;
    if (isRhythmVerseDriveFolder(record.downloadUrl)) {
      extracted = await downloadRhythmVerseDriveFolder({ url: record.downloadUrl, directory, signal, includeVideo });
    } else {
      await download({ url: record.downloadUrl, filename: archiveFile, signal });
      extracted = await extract({ archiveFile, directory, signal });
    }
    const chart = await fs.realpath(extracted);
    if (!isChild(staging, chart) || (path.relative(directory, chart) !== '' && !isChild(directory, chart))) {
      throw Error('Le dossier du chart extrait est invalide.');
    }
    signal.throwIfAborted();
    if (!includeVideo) await removeVideos(chart, signal);
    await guardRoot();
    if (save) {
      const filename = path.join(staging, `prepared.${format}`);
      const write = format === 'zip' ? writeRhythmVerseZip : writeRhythmVerseSng;
      await write({ directory: chart, filename, signal, includeVideo });
      await publishSavedFile(filename, save, signal, guardRoot);
      return save.destination;
    }
    const base = songFolderName(record);
    for (let suffix = 1; !destination; suffix++) {
      signal.throwIfAborted();
      const candidate = path.join(root, suffix === 1 ? base : `${base} (${suffix})`);
      try {
        await fs.mkdir(candidate, { mode: 0o700 });
        destination = candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    destinationIdentity = await fs.lstat(destination, { bigint: true });
    async function guardDestination() {
      await guardRoot();
      const current = await fs.lstat(destination, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== destinationIdentity.dev || current.ino !== destinationIdentity.ino
        || path.relative(destination, await fs.realpath(destination))) throw Error('Le dossier de destination a changé.');
    }
    for (const entry of await fs.readdir(chart)) {
      signal.throwIfAborted();
      await guardDestination();
      const target = path.join(destination, entry);
      const exists = await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) throw Error('Un fichier existe déjà dans le dossier de destination.');
      await fs.rename(path.join(chart, entry), target);
    }
    await guardDestination();
    complete = true;
    return destination;
  } finally {
    await removeOwnedDirectory(root, staging, stagingIdentity);
    if (!complete && destinationIdentity) await removeOwnedDirectory(root, destination, destinationIdentity);
  }
}

module.exports = { installRhythmVerseChart };
