'use strict';

const { execFile } = require('node:child_process');
const { statSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const MiB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * MiB;
const MAX_ENTRY_BYTES = 256 * MiB;
const MAX_EXPANDED_BYTES = 512 * MiB;
const MAX_ENTRIES = 1024;
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SEVEN_ZIP = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const audio = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const assets = new Set([...audio, '.avi', '.bmp', '.chart', '.gif', '.jpeg', '.jpg', '.lrc', '.md', '.mid', '.midi', '.mkv', '.mov', '.mp4', '.nfo', '.png', '.txt', '.webm', '.webp', '.wmv']);
const metadata = new Set(['song.ini', '.ds_store', 'thumbs.db']);

function invalidArchive() {
  return new Error('Cette archive est invalide, trop volumineuse ou contient des fichiers non pris en charge.');
}

function systemTar() {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !/^[a-z]:\\[^\\]+$/i.test(windows ?? '')) {
    throw new Error('L’extraction requiert l’outil tar de Windows.');
  }
  return path.join(windows, 'System32', 'tar.exe');
}

function canUseNativeRhythmVerseArchives() {
  try {
    return statSync(systemTar()).isFile();
  } catch {
    return false;
  }
}

async function runTar(executable, args, signal) {
  signal?.throwIfAborted();
  try {
    const { stdout, stderr } = await exec(executable, args, {
      encoding: 'buffer', maxBuffer: MiB, timeout: 90_000, windowsHide: true, shell: false, signal,
    });
    if (stderr.length) throw invalidArchive();
    return stdout;
  } catch {
    signal?.throwIfAborted();
    throw invalidArchive();
  }
}

async function listingDecoder(executable, output, signal) {
  if (output.every(bytes => bytes.every(byte => byte < 128))) return new TextDecoder('utf-8');
  // Windows bsdtar sends filenames through the system ANSI encoding when stdout is piped.
  const registry = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';
  const labels = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8' };
  try {
    const { stdout } = await exec(path.join(path.dirname(executable), 'reg.exe'), ['query', registry, '/v', 'ACP'], {
      encoding: 'utf8', maxBuffer: 4096, timeout: 3000, windowsHide: true, shell: false, signal,
    });
    const page = /\bACP\s+REG_SZ\s+(\d+)\b/i.exec(stdout)?.[1];
    if (!page) throw invalidArchive();
    return new TextDecoder(labels[page] ?? `windows-${page}`, { fatal: true, ignoreBOM: true });
  } catch {
    signal?.throwIfAborted();
    throw invalidArchive();
  }
}

async function plainStat(filename, directory) {
  const info = await fs.lstat(filename, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
    || path.relative(filename, await fs.realpath(filename))) throw invalidArchive();
  return info;
}

function sameFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
}

async function verifySignature(filename, info) {
  if (info.size < 22n || info.size > BigInt(MAX_ARCHIVE_BYTES)) throw invalidArchive();
  const handle = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(6);
    if (!sameFile(info, await handle.stat({ bigint: true }))) throw invalidArchive();
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !(header.subarray(0, 4).equals(ZIP) || header.equals(SEVEN_ZIP))) {
      throw new Error('Le fichier téléchargé doit être une archive ZIP ou 7z.');
    }
  } finally {
    await handle.close();
  }
}

function lines(output) {
  if (!output.endsWith('\n')) throw invalidArchive();
  return output.replace(/\r?\n$/, '').split(/\r?\n/);
}

function memberPath(rawName, directory) {
  if (!directory && rawName.endsWith('/')) throw invalidArchive();
  const name = rawName.replace(/^\.\//, '').replace(/\/$/, '');
  if (directory && rawName === './') return '';
  if (!name || name.length > 240 || /[<>:"\\|?*\u0000-\u001f\u007f\ufffd\u202a-\u202e\u2066-\u2069]/u.test(name)) throw invalidArchive();
  for (const part of name.split('/')) {
    if (!part || part.length > 180 || Buffer.byteLength(part) > 255 || /^[ ]|[. ]$/u.test(part)
      || /^(?:con(?:in\$|out\$)?|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) throw invalidArchive();
  }
  return name;
}

const keyFor = value => value.normalize('NFC').toLowerCase();

function archiveTree(rawNames, rawDetails) {
  const names = lines(rawNames), details = lines(rawDetails);
  if (names.length > MAX_ENTRIES || names.length !== details.length) throw invalidArchive();
  const tree = new Map(), declared = new Set();
  let total = 0;

  function add(name, directory, size) {
    const key = keyFor(name);
    const existing = tree.get(key);
    if (existing && (existing.name !== name || existing.directory !== directory)) throw invalidArchive();
    tree.set(key, { name, directory, size });
    if (tree.size > MAX_ENTRIES) throw invalidArchive();
  }

  for (const [index, rawName] of names.entries()) {
    const line = details[index];
    if (!rawName || !line.endsWith(rawName)) throw invalidArchive();
    // Match the complete metadata prefix against the unadorned listing. This
    // rejects symlinks and hardlinks, whose verbose listings include a target.
    const prefix = line.slice(0, -rawName.length);
    const match = /^([d-])[rwxstST-]{9}\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2})\s+$/u.exec(prefix);
    if (!match) throw invalidArchive();
    const directory = match[1] === 'd';
    const size = Number(match[2]);
    const name = memberPath(rawName, directory);
    const key = keyFor(name);
    if (declared.has(key) || !Number.isSafeInteger(size) || size > MAX_ENTRY_BYTES || (directory && size !== 0)) throw invalidArchive();
    declared.add(key);
    if (!name) continue;
    total += size;
    if (total > MAX_EXPANDED_BYTES) throw invalidArchive();
    if (!directory) {
      const filename = path.posix.basename(key);
      if (!assets.has(path.posix.extname(filename)) && !metadata.has(filename)) throw invalidArchive();
    }
    const parts = name.split('/');
    for (let level = 1; level < parts.length; level++) add(parts.slice(0, level).join('/'), true, 0);
    add(name, directory, size);
  }
  return tree;
}

function chartFolder(tree) {
  const folders = new Map();
  for (const [key, member] of tree) {
    if (member.directory || !member.size) continue;
    const folder = path.posix.dirname(key);
    if (!folders.has(folder)) folders.set(folder, new Set());
    folders.get(folder).add(path.posix.basename(key));
  }
  const charts = [];
  for (const [folder, files] of folders) {
    if ((files.has('notes.chart') || files.has('notes.mid')) && files.has('song.ini')
      && [...files].some(name => audio.has(path.posix.extname(name)))) charts.push(folder);
  }
  if (!charts.length) throw new Error('Aucun dossier Clone Hero complet trouvé dans l’archive.');
  return charts.length === 1 && charts[0] !== '.' ? tree.get(charts[0]).name : '';
}

async function verifyExtracted(directory, tree, signal) {
  const pending = [''];
  const visited = new Set();
  while (pending.length) {
    const parent = pending.pop();
    for (const name of await fs.readdir(path.join(directory, parent))) {
      signal?.throwIfAborted();
      const relative = parent ? `${parent}/${name}` : name;
      const key = keyFor(relative);
      const expected = tree.get(key);
      if (!expected || expected.name !== relative || visited.has(key)) throw invalidArchive();
      const filename = path.join(directory, relative);
      const info = await plainStat(filename, expected.directory);
      if (expected.directory) pending.push(relative);
      else if (info.size !== BigInt(expected.size)) throw invalidArchive();
      // Windows can preserve a 7z member's read-only attribute despite the tar permission flags.
      if (process.platform === 'win32') await fs.chmod(filename, expected.directory ? 0o700 : 0o600);
      visited.add(key);
    }
  }
  if (visited.size !== tree.size) throw invalidArchive();
}

async function extractRhythmVerseArchive({ archiveFile, directory, signal }) {
  if (!path.isAbsolute(archiveFile) || !path.isAbsolute(directory)) throw invalidArchive();
  const executable = systemTar();
  const root = await plainStat(directory, true);
  const archive = await plainStat(archiveFile, false);
  const checkArchive = async () => {
    if (!sameFile(archive, await plainStat(archiveFile, false))) throw invalidArchive();
  };
  const checkRoot = async empty => {
    const info = await plainStat(directory, true);
    if (info.dev !== root.dev || info.ino !== root.ino || (empty && (await fs.readdir(directory)).length)) throw invalidArchive();
  };

  await checkRoot(true);
  await verifySignature(archiveFile, archive);
  const names = await runTar(executable, ['-tf', archiveFile], signal);
  await checkArchive();
  const details = await runTar(executable, ['-tvf', archiveFile, '--numeric-owner'], signal);
  const decoder = await listingDecoder(executable, [names, details], signal);
  const tree = archiveTree(decoder.decode(names), decoder.decode(details));
  const chart = chartFolder(tree);
  await checkArchive();
  await checkRoot(true);
  await runTar(executable, ['-xkf', archiveFile, '-C', directory, '-m', '--no-same-owner', '--no-same-permissions', '--no-acls', '--no-xattrs', '--no-fflags'], signal);
  await checkArchive();
  await checkRoot(false);
  await verifyExtracted(directory, tree, signal);
  return path.join(directory, chart);
}

async function writeRhythmVerseZip({ directory, filename, signal }) {
  await plainStat(directory, true);
  await runTar(systemTar(), ['-c', '--format', 'zip', '-f', filename, '-C', directory, '.'], signal);
  const info = await plainStat(filename, false);
  if (info.size < 22n || info.size > BigInt(MAX_EXPANDED_BYTES + MiB)) throw invalidArchive();
}

module.exports = { canUseNativeRhythmVerseArchives, extractRhythmVerseArchive, writeRhythmVerseZip };
