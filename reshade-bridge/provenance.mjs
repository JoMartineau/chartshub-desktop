import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=[];
for(const project of ['reshade','nlohmann'])for(const file of (await fs.readdir(path.join(root,'vendor',project))).sort()){
  const relative=`${project}/${file}`;
  const url=project==='reshade'?`https://raw.githubusercontent.com/crosire/reshade/v6.8.0/${file==='LICENSE.md'?'LICENSE.md':`include/${file}`}`:`https://raw.githubusercontent.com/nlohmann/json/v3.11.3/${file==='json.hpp'?'single_include/nlohmann/json.hpp':'LICENSE.MIT'}`;
  files.push({file:relative,url,sha256:createHash('sha256').update(await fs.readFile(path.join(root,'vendor',relative))).digest('hex')});
}
await fs.writeFile(path.join(root,'vendor/PROVENANCE.json'),JSON.stringify({reshadeVersion:'v6.8.0',reshadeApiVersion:20,jsonVersion:'v3.11.3',files},null,2)+'\n');
