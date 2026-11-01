'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const FILES = Object.freeze(['ChartsHubDrumHost.exe', 'THIRD-PARTY-NOTICES.txt', 'licenses/VST3-SDK-MIT.txt', 'licenses/nlohmann-json-MIT.txt']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inspectDrumHost(sourceRoot) {
  const bin = path.join(sourceRoot, 'native-drum-host', 'bin');
  const files = FILES.map(name => {
    const file = path.join(bin, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16 * 1024 * 1024) throw Error('Invalid native drum dependency: ' + name);
    const bytes = fs.readFileSync(file);
    if (name.endsWith('.exe')) {
      const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset + 24 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw Error('Build the Windows x64 native drum host before packaging.');
    }
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { schema: 1, platform: 'win32', arch: 'x64', files };
}

function copyDrumHost(sourceRoot, applicationOutput) {
  const before = inspectDrumHost(sourceRoot);
  const directory = path.join(applicationOutput, 'resources', 'native-drum-host');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of before.files) {
    const target = path.join(directory, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'native-drum-host', 'bin', file.name), target, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(target)) !== file.sha256) throw Error('Native drum dependency changed during packaging.');
  }
  if (JSON.stringify(inspectDrumHost(sourceRoot)) !== JSON.stringify(before)) throw Error('Native drum source changed during packaging.');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
  return before;
}
module.exports = { FILES, inspectDrumHost, copyDrumHost };
