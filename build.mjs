import {packager} from '@electron/packager';
import path from 'node:path';
const platform=process.argv[2]||process.platform,arch=process.argv[3]||process.arch;
if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('Unsupported platform');
const outputs=await packager({dir:import.meta.dirname,name:'ChartsHub',appBundleId:'ca.chartshub.desktop',appVersion:'0.1.2',icon:path.join(import.meta.dirname,platform==='win32'?'icon.ico':platform==='darwin'?'icon.icns':'icon.png'),platform,arch,electronVersion:'44.4.5',out:path.resolve(import.meta.dirname,'dist'),overwrite:true,asar:true,prune:true,download:{cacheRoot:path.resolve(import.meta.dirname,'../electron-cache')},ignore:[/^\/dist(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/smoke-test\.js$/,/^\/build\.mjs$/,/^\/package-lock\.json$/]});
if(!outputs.length)throw Error('No application was built. Build on a native runner for this platform.');
console.log(outputs.join('\n'));
