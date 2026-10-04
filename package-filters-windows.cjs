'use strict';
// Local, reproducible packaging from the already installed Electron runtime.
// No account data, game files or compiler caches enter the delivery.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
async function main() {
  const root = __dirname;
  const destination = path.resolve(process.argv[2] || path.join(root, 'dist', 'ChartsHub-Filters-Windows'));
  const stage = path.resolve(process.argv[3] || path.join(root, 'dist', 'filters-staging'));
  for (const directory of [destination, stage]) {
    try { await fs.lstat(directory); throw Error('Destination already exists: ' + directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const dll = path.join(root, 'native-filters', 'bin', 'dxgi.dll');
  const bytes = await fs.readFile(dll);
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('Native engine must be compiled before packaging.');
  const addon = path.join(root, 'reshade-bridge', 'bin', 'ChartsHubReShade.addon64');
  const addonBytes = await fs.readFile(addon);
  if (addonBytes.toString('ascii', 0, 2) !== 'MZ') throw Error('ReShade bridge must be compiled before packaging.');
  await fs.mkdir(stage, { recursive: true });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && (/\.js$/.test(entry.name) || /^(package\.json|icon\.(ico|png|icns)|COMPANION-README\.txt)$/.test(entry.name)) && !['smoke-test.js'].includes(entry.name)) {
      await fs.copyFile(path.join(root, entry.name), path.join(stage, entry.name));
    }
  }
  for (const directory of ['companion', 'desktop', 'docs']) await fs.cp(path.join(root, directory), path.join(stage, directory), { recursive: true, filter: source => !source.split(path.sep).includes('src') });
  await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });
  await fs.cp(path.join(root, 'node_modules', 'ws'), path.join(stage, 'node_modules', 'ws'), { recursive: true, dereference: true });
  await fs.mkdir(path.join(stage, 'native-filters', 'bin'), { recursive: true });
  await fs.copyFile(dll, path.join(stage, 'native-filters', 'bin', 'dxgi.dll'));
  await fs.copyFile(path.join(root, 'native-filters', 'vendor', 'minhook', 'LICENSE.txt'), path.join(stage, 'native-filters', 'MINHOOK-LICENSE.txt'));
  await fs.mkdir(path.join(stage, 'reshade-bridge', 'bin'), { recursive: true });
  await fs.copyFile(addon, path.join(stage, 'reshade-bridge', 'bin', 'ChartsHubReShade.addon64'));
  for (const [source, target] of [['reshade/LICENSE.md', 'ReShade-LICENSE.txt'], ['nlohmann/LICENSE.MIT', 'JSON-LICENSE.txt']]) {
    await fs.copyFile(path.join(root, 'reshade-bridge', 'vendor', source), path.join(stage, 'reshade-bridge', target));
  }
  const electronRoot = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  await fs.cp(electronRoot, destination, { recursive: true, dereference: true, filter: source => !['debug.log', 'default_app.asar'].includes(path.basename(source)) });
  await fs.rename(path.join(destination, 'electron.exe'), path.join(destination, 'ChartsHub.exe'));
  const asar = await import('@electron/asar');
  await fs.mkdir(path.join(destination, 'resources'), { recursive: true });
  await asar.createPackage(stage, path.join(destination, 'resources', 'app.asar'));
  const { resedit } = await import('@electron/packager/resedit');
  await resedit(path.join(destination, 'ChartsHub.exe'), {
    productVersion: version, fileVersion: version, productName: 'ChartsHub', iconPath: path.join(root, 'icon.ico'),
    win32Metadata: { FileDescription: 'ChartsHub', InternalName: 'ChartsHub', OriginalFilename: 'ChartsHub.exe', ProductName: 'ChartsHub' }
  });
  await fs.copyFile(path.join(root, 'COMPANION-README.txt'), path.join(destination, 'Lisez-moi.txt'));
  await fs.copyFile(path.join(root, 'docs', 'FILTERS.txt'), path.join(destination, 'Filtres-du-jeu.txt'));
  await fs.copyFile(path.join(root, 'docs', 'RESHADE.txt'), path.join(destination, 'Effets-ReShade.txt'));
  await fs.writeFile(path.join(destination, 'Lancer Companion.cmd'), [
    '@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE="',
    'start "ChartsHub" "%~dp0ChartsHub.exe" --companion', 'exit /b 0', ''
  ].join('\r\n'));
  const manifest = { version, nativeModuleSHA256: createHash('sha256').update(bytes).digest('hex'), reshadeBridgeSHA256: createHash('sha256').update(addonBytes).digest('hex'),
    executableSHA256: createHash('sha256').update(await fs.readFile(path.join(destination, 'ChartsHub.exe'))).digest('hex'),
    appSHA256: createHash('sha256').update(await fs.readFile(path.join(destination, 'resources', 'app.asar'))).digest('hex') };
  await fs.writeFile(path.join(destination, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ destination, ...manifest }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
