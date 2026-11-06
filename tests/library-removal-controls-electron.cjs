'use strict';
// Synthetic, hidden renderer only: no Songs folder, native trash or network.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const directory = path.resolve(process.argv[2] || path.join(__dirname, '../../library-removal-ui-verification'));
app.setPath('userData', path.join(directory, 'isolated-profile')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const errors = [], externalRequests = [], captures = [], passed = []; let window;
const fileURL = file => pathToFileURL(path.resolve(__dirname, '../companion/ui', file)).href;
const evaluate = source => window.webContents.executeJavaScript(source);
const timer = setTimeout(() => { console.error('Library removal UI fixture timed out'); app.exit(1); }, 60000);
async function record(label, action) { await action(); passed.push(label); }
async function capture(filename, width) { await new Promise(resolve => setTimeout(resolve, 100)); await fs.writeFile(path.join(directory, filename), (await window.webContents.capturePage({ x: 0, y: 0, width, height: 920 }, { stayHidden: true, stayAwake: true })).toPNG()); captures.push(filename); }
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true }); const fixture = path.join(directory, 'fixture.html');
  await fs.writeFile(fixture, '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic library removal</title>' +
    '<link rel="stylesheet" href="' + fileURL('companion.css') + '"><link rel="stylesheet" href="' + fileURL('library-removal-controls.css') + '">' +
    '<style>body{padding:16px;box-sizing:border-box;min-width:0}main{max-width:1280px;margin:0 auto}</style></head><body><main><details id="removal" class="library-removal-controls"></details></main></body></html>');
  window = new BrowserWindow({ show: false, width: 1400, height: 920, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = /^(file:|data:|about:)/.test(details.url); if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
  await window.loadFile(fixture);
  await evaluate(`(async()=>{const{LibraryRemovalControls}=await import(${JSON.stringify(fileURL('library-removal-controls.js'))});window.calls=[];window.syntheticId=i=>i.toString(16).padStart(64,'0');window.syntheticItem=i=>({id:syntheticId(i),title:'Signal de démonstration '+i,artist:'Groupe Exemple',album:'Album Démo',relativePath:'Collection/Signal de démonstration '+i+'/notes.chart'});window.controls=new LibraryRemovalControls({root:document.querySelector('#removal'),command:async(name,payload)=>{calls.push([name,payload]);if(name==='library.selectedRemovalQuery')return{ok:true,result:{rootKey:'a'.repeat(64),revision:1,total:100000,offset:payload.offset,limit:50,items:Array.from({length:50},(_,i)=>syntheticItem(i+payload.offset+1))}};if(name==='library.selectedRemovalIds')return{ok:true,result:{rootKey:'a'.repeat(64),revision:1,total:100000,ids:Array.from({length:1000},(_,i)=>syntheticId(i+1)),truncated:true}};if(name==='library.prepareSelectedRemoval')return{ok:true,result:{planId:'12345678-1234-4234-8234-123456789abc',rootKey:'a'.repeat(64),revision:1,count:1000,eligibleCount:998,blockedCount:2,totalBytes:998000000000,entries:payload.ids.slice(0,50).map((id,i)=>({...syntheticItem(i+1),id,targetRelativePath:'Collection/Signal de démonstration '+(i+1),bytes:1000000000,eligible:i!==0,blocked:i===0?'changed':null})),previewTruncated:true}};return{ok:true}}});window.synthetic={language:'fr',library:{settings:{rootPath:'C:/Synthetic/Songs'},status:'ready',revision:1,selectedRemoval:{phase:'idle',processed:0,total:0}}};controls.update(synthetic)})()`);
  await record('Closed panel never queries or recycles anything', async () => assert.deepEqual(await evaluate('calls'), []));
  await evaluate("document.querySelector('#removal').open=true;document.querySelector('#removal').dispatchEvent(new Event('toggle'))");
  await record('Opening100000-chart index renders at most50 rows', async () => { assert.equal(await evaluate('controls.nodes.list.children.length'), 50); assert.equal(await evaluate('calls.length'), 1); });
  for (const [width, language] of [[1400, 'fr'], [680, 'en']]) {
    window.setContentSize(width, 920); await evaluate(`synthetic.language=${JSON.stringify(language)};controls.update(synthetic);scrollTo(0,0)`);
    await record('No horizontal overflow while browsing ' + width + 'px', async () => assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true));
    await capture('library-removal-browse-' + language + '-' + width + '.png', width);
  }
  await evaluate('controls.selectResults()'); await evaluate('controls.prepare()');
  await record('Review is bounded50 entries and accurately states selected total1000', async () => {
    assert.equal(await evaluate('controls.nodes.previewItems.children.length'), 50); assert.equal(await evaluate('controls.selected.size'), 1000); assert.match(await evaluate('controls.nodes.previewSummary.textContent'), /998.*2/);
    assert.equal(await evaluate("calls.some(([name])=>name==='library.recycleSelectedRemoval')"), false);
  });
  for (const [width, language] of [[1400, 'fr'], [680, 'en']]) {
    window.setContentSize(width, 920); await evaluate(`synthetic.language=${JSON.stringify(language)};controls.update(synthetic);controls.nodes.preview.scrollIntoView({block:'start'})`);
    await record('Final review action fits panel at ' + width + 'px', async () => assert.equal(await evaluate('(()=>{const p=controls.nodes.preview.getBoundingClientRect(),b=controls.nodes.recycle.getBoundingClientRect();return b.width>0&&b.left>=p.left&&b.right<=p.right&&document.documentElement.scrollWidth<=innerWidth})()'), true));
    await capture('library-removal-review-' + language + '-' + width + '.png', width);
  }
  await record('Cancellation discards proof without sending any recycle command', async () => { await evaluate('controls.cancel()'); assert.equal(await evaluate('controls.plan'), null); assert.equal(await evaluate("calls.some(([name])=>name==='library.recycleSelectedRemoval')"), false); });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.equal(window.isVisible(), false);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ result: 'LIBRARY_REMOVAL_UI_OK', passed, captures, errors, externalRequests, hidden: true }, null, 2));
  console.log(JSON.stringify({ result: 'LIBRARY_REMOVAL_UI_OK', checks: passed.length, directory })); clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(async error => { console.error(error); await fs.mkdir(directory, { recursive: true }).catch(() => {}); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ result: 'LIBRARY_REMOVAL_UI_FAILED', error: String(error.stack || error), passed, errors, externalRequests }, null, 2)).catch(() => {}); clearTimeout(timer); app.exit(1); });
