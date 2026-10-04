import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const names = ['LICENSE.txt','include/MinHook.h','src/buffer.c','src/buffer.h','src/hook.c','src/trampoline.c','src/trampoline.h','src/hde/hde64.c','src/hde/hde64.h','src/hde/pstdint.h','src/hde/table64.h'];
for (const name of names) {
  const bytes = await new Promise((resolve,reject)=>https.get(`https://raw.githubusercontent.com/TsudaKageyu/minhook/v1.3.4/${name}`,res=>{if(res.statusCode!==200){reject(new Error(`HTTP ${res.statusCode}: ${name}`));res.resume();return;} const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);}).on('error',reject));
  await fs.writeFile(path.join(root,'vendor/minhook',name),bytes);
  console.log(name);
}
