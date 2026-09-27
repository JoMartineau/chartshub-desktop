import {packager} from '@electron/packager';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
const platform=process.argv[2]||process.platform,arch=process.argv[3]||process.arch;
if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('Unsupported platform');
const electronZipDir=process.env.CHARTSHUB_ELECTRON_ZIP_DIR;
if(electronZipDir){
 const archive=`electron-v44.4.5-${platform}-${arch}.zip`;
 const checksums=JSON.parse(readFileSync(new URL('./node_modules/electron/checksums.json',import.meta.url),'utf8'));
 if(!checksums[archive]||createHash('sha256').update(readFileSync(path.join(electronZipDir,archive))).digest('hex')!==checksums[archive])throw Error('Cached Electron archive failed SHA-256 verification.');
}
const outputs=await packager({dir:import.meta.dirname,name:'ChartsHub',appBundleId:'ca.chartshub.desktop',appVersion:version,icon:path.join(import.meta.dirname,platform==='win32'?'icon.ico':platform==='darwin'?'icon.icns':'icon.png'),platform,arch,electronVersion:'44.4.5',electronZipDir,out:path.resolve(import.meta.dirname,'dist'),overwrite:true,asar:true,prune:true,download:{cacheRoot:path.resolve(import.meta.dirname,'../electron-cache')},ignore:[/^\/dist(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/smoke-test\.js$/,/^\/build\.mjs$/,/^\/package-lock\.json$/]});
if(!outputs.length)throw Error('No application was built. Build on a native runner for this platform.');
console.log(outputs.join('\n'));
