import {packager} from '@electron/packager';
import path from 'node:path';
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
const platform=process.argv[2]||process.platform,arch=process.argv[3]||process.arch;
if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('Unsupported platform');
if(platform==='win32'&&arch==='x64'&&!existsSync(new URL('./native-filters/bin/dxgi.dll',import.meta.url)))throw Error('Compile the native filter engine with native-filters/build.ps1 before packaging Windows x64. See native-filters/README.md.');
if(platform==='win32'&&arch==='x64'&&!existsSync(new URL('./reshade-bridge/bin/ChartsHubReShade.addon64',import.meta.url)))throw Error('Compile the ReShade bridge with reshade-bridge/build.ps1 before packaging Windows x64.');
if(platform==='win32'&&arch==='x64')for(const notice of ['native-filters/bin/MinHook-LICENSE.txt','reshade-bridge/bin/ReShade-SDK-LICENSE.md','reshade-bridge/bin/nlohmann-LICENSE.MIT'])if(!existsSync(new URL('./'+notice,import.meta.url)))throw Error('Missing dependency license: '+notice);
const electronZipDir=process.env.CHARTSHUB_ELECTRON_ZIP_DIR;
const outputDirectory=process.env.CHARTSHUB_DESKTOP_OUT||path.resolve(import.meta.dirname,'dist');
if(electronZipDir){
 const archive=`electron-v44.4.5-${platform}-${arch}.zip`;
 const checksums=JSON.parse(readFileSync(new URL('./node_modules/electron/checksums.json',import.meta.url),'utf8'));
 if(!checksums[archive]||createHash('sha256').update(readFileSync(path.join(electronZipDir,archive))).digest('hex')!==checksums[archive])throw Error('Cached Electron archive failed SHA-256 verification.');
}
const outputs=await packager({dir:import.meta.dirname,name:'ChartsHub',appBundleId:'ca.chartshub.desktop',appVersion:version,icon:path.join(import.meta.dirname,platform==='win32'?'icon.ico':platform==='darwin'?'icon.icns':'icon.png'),platform,arch,electronVersion:'44.4.5',electronZipDir,out:outputDirectory,overwrite:true,asar:true,prune:true,download:{cacheRoot:path.resolve(import.meta.dirname,'../electron-cache')},ignore:[/^\/dist(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/smoke-test\.js$/,/^\/build\.mjs$/,/^\/package-filters-windows\.cjs$/,/^\/package-lock\.json$/,/^\/Companion-Data(?:\/|$)/,/^\/native-filters\/(?!bin(?:\/|$)|README\.md$)/,/^\/native-filters\/bin\/(?!dxgi\.dll$|MinHook-LICENSE\.txt$)/,/^\/reshade-bridge\/(?!bin(?:\/|$)|README\.md$)/,/^\/reshade-bridge\/bin\/(?!ChartsHubReShade\.addon64$|ReShade-SDK-LICENSE\.md$|nlohmann-LICENSE\.MIT$)/]});
if(!outputs.length)throw Error('No application was built. Build on a native runner for this platform.');
for(const output of outputs){
 copyFileSync(new URL('./COMPANION-README.txt',import.meta.url),path.join(output,'Lisez-moi.txt'));
 mkdirSync(path.join(output,'Song Request'),{recursive:true});
 copyFileSync(new URL('./docs/SONG-REQUESTS.md',import.meta.url),path.join(output,'Song Request','Configuration.md'));
 copyFileSync(new URL('./docs/song-requests/ChartsHub-SongRequest.cs',import.meta.url),path.join(output,'Song Request','ChartsHub-SongRequest.cs'));
 if(platform==='win32')writeFileSync(path.join(output,'Lancer Companion.cmd'),[
  '@echo off','setlocal','set "ELECTRON_RUN_AS_NODE="',
  'start "ChartsHub" "%~dp0ChartsHub.exe" --companion',
  'exit /b 0',''
 ].join('\r\n'),'utf8');
}
console.log(outputs.join('\n'));
