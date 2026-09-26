'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function folderPreferences(userData){
 const file=path.join(userData,'download-folders.json');let values;
 async function read(){if(!values){try{const data=JSON.parse(await fs.readFile(file,'utf8'));values=data&&typeof data==='object'?data:{};}catch{values={};}}return values;}
 return {
  async get(kind='catalogue'){const value=(await read())[kind];if(typeof value!=='string'||!path.isAbsolute(value))return null;try{const real=await fs.realpath(value);return (await fs.stat(real)).isDirectory()?real:null;}catch{return null;}},
  async set(kind,value){if(!['catalogue','review'].includes(kind))throw Error('Invalid folder preference');const real=await fs.realpath(value);if(!(await fs.stat(real)).isDirectory())throw Error('Choose a folder');const prefs=await read();prefs[kind]=real;await fs.mkdir(userData,{recursive:true});await fs.writeFile(file,JSON.stringify(prefs),{mode:0o600});return real;}
 };
}
module.exports={folderPreferences};
