import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=[...['reshade.hpp','reshade_overlay.hpp','reshade_events.hpp','reshade_api.hpp','reshade_api_device.hpp','reshade_api_pipeline.hpp','reshade_api_resource.hpp','reshade_api_format.hpp'].map(n=>[`https://raw.githubusercontent.com/crosire/reshade/v6.8.0/include/${n}`,`vendor/reshade/${n}`]),['https://raw.githubusercontent.com/crosire/reshade/v6.8.0/LICENSE.md','vendor/reshade/LICENSE.md'],['https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp','vendor/nlohmann/json.hpp'],['https://raw.githubusercontent.com/nlohmann/json/v3.11.3/LICENSE.MIT','vendor/nlohmann/LICENSE.MIT']];
for(const [url,file] of files){const bytes=await new Promise((resolve,reject)=>https.get(url,res=>{if(res.statusCode!==200){res.resume();return reject(new Error(`HTTP${res.statusCode} ${url}`));}const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve(Buffer.concat(parts)));res.on('error',reject);}).on('error',reject));await fs.writeFile(path.join(root,file),bytes);console.log(file);}
