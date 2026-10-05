'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createUIBloomStore, createUIBloomIpc } = require('../desktop/ui-bloom.cjs');
const model = import('../companion/ui/ui-bloom-model.js');
const PANEL = 'chartshub-companion://app/ui/index.html';
const READ = 'chartshub-ui-bloom:read', SAVE = 'chartshub-ui-bloom:save', READY = 'chartshub-ui-bloom:ready';
async function directory(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-bloom-')); t.after(() => fs.rm(p, { recursive: true, force: true })); return p; }
function fixture(createStore) {
  const handlers = new Map(), sent = [];
  let available = true;
  const contents = { mainFrame: { url: PANEL }, getURL: () => PANEL, isDestroyed: () => false, send: c => sent.push(c) };
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: c => handlers.delete(c) };
  const controller = createUIBloomIpc({ ipcMain, getContents: () => contents, isAvailable: () => available, getDirectory: () => '/not-used', createStore });
  return { handlers, contents, event, controller, sent, setAvailable: value => { available = value; } };
}
test('shared defaults are opt-in and match website ranges', async () => {
  const m = await model; assert.equal(m.DEFAULTS.enabled, false); assert.equal(m.shadow(m.DEFAULTS), 'none');
  assert.deepEqual(Object.keys(m.DEFAULTS).sort(), ['version','enabled','color','intensity','radius','blur','opacity','economy'].sort());
  assert.deepEqual(m.RANGES.blur, [0,80,' px']);
});
test('HEX and RGB freely select colors without CSS injection', async () => {
  const m = await model;
  assert.equal(m.color('ABC'), '#aabbcc'); assert.equal(m.color(' #00FF9a '), '#00ff9a');
  assert.deepEqual(m.rgb('#00ff9a'), [0,255,154]); assert.equal(m.fromRGB([255,123,0]), '#ff7b00');
  for (const c of ['red','#ffff','url(x)','#ffffff;opacity:0',null,{},'']) assert.equal(m.color(c),null);
  for (const c of [[256,0,0], [-1,0,0], [1.5,2,3], [NaN,2,3], [1,2], ['1',2,3]]) assert.equal(m.fromRGB(c), null);
});
test('strict native validator rejects unknown keys and invalid values', async () => {
  const m = await model;
  for (const patch of [{version:2}, {enabled:'true'}, {economy:1}, {color:'#abc'}, {intensity:101}, {radius:-1}, {blur:NaN}, {opacity:1.5}, {path:'/tmp/anywhere'}]) assert.equal(m.validate({...m.DEFAULTS,...patch}),null);
  assert.equal(m.validate(null),null); assert.equal(m.validate([]),null); assert.equal(m.validate({}),null);
  assert.deepEqual(m.validate({...m.DEFAULTS,color:'#AABBCC'}), {...m.DEFAULTS,color:'#aabbcc'});
});
test('normalizer clamps values and does not copy prototype or unexpected properties', async () => {
  const m = await model, p = m.normalize(JSON.parse('{"__proto__":{"polluted":true},"radius":999,"blur":-1,"opacity":"70","token":"secret"}'));
  assert.equal(p.radius,24); assert.equal(p.blur,0); assert.equal(p.opacity,65); assert.equal(Object.hasOwn(p,'token'),false); assert.equal(Object.hasOwn(p,'__proto__'),false);
});
test('economy mode uses one bounded halo; zero settings disable it', async () => {
  const m = await model;
  assert.equal(m.shadow({enabled:true,economy:true,blur:80,radius:24,intensity:100,opacity:100,color:'#00ff00'}), '0 0 16px 3px rgba(0, 255, 0, 0.650)');
  for (const patch of [{enabled:false},{intensity:0},{opacity:0}]) assert.equal(m.shadow({enabled:true,...patch}),'none');
  assert.notEqual(m.shadow({enabled:true,intensity:50,opacity:100}),m.shadow({enabled:true,intensity:100,opacity:50}));
});
test('native settings survive a new store instance and never create widget files', async t => {
  const dir = await directory(t), m = await model, store = await createUIBloomStore(dir);
  assert.deepEqual((await store.read()).settings,m.DEFAULTS);
  const value = {...m.DEFAULTS,enabled:true,color:'#ff8800',opacity:80};
  await store.save(value);
  assert.deepEqual((await (await createUIBloomStore(dir)).read()).settings,value);
  assert.deepEqual(await fs.readdir(dir),['ui-bloom.json']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir,'ui-bloom.json'))).mode & 0o777,0o600);
});
test('malformed and oversized files are preserved until explicit Apply', async t => {
  const dir = await directory(t), file = path.join(dir,'ui-bloom.json'), store = await createUIBloomStore(dir);
  for (const text of ['broken','x'.repeat(3000),'{"version":2}','null']) {
    await fs.writeFile(file,text); const result = await store.read();
    assert.equal(result.warning,'invalid'); assert.equal(result.settings.enabled,false); assert.equal(await fs.readFile(file,'utf8'),text);
  }
});
test('invalid writes do not alter the previously saved appearance', async t => {
  const dir = await directory(t), m = await model, store = await createUIBloomStore(dir);
  await store.save(m.DEFAULTS); const before = await fs.readFile(path.join(dir,'ui-bloom.json'),'utf8');
  await assert.rejects(store.save({...m.DEFAULTS,unexpected:true}));
  assert.equal(await fs.readFile(path.join(dir,'ui-bloom.json'),'utf8'),before);
});
test('symlink targets are not read or overwritten', async t => {
  if (process.platform === 'win32') return t.skip('Symlink privileges vary on Windows; test on native release runner.');
  const dir = await directory(t), target = path.join(dir,'target.json'), m = await model;
  await fs.writeFile(target,'do not replace'); await fs.symlink(target,path.join(dir,'ui-bloom.json'));
  const store = await createUIBloomStore(dir); await assert.rejects(store.read()); await assert.rejects(store.save(m.DEFAULTS));
  assert.equal(await fs.readFile(target,'utf8'),'do not replace');
});
test('IPC rejects wrong windows, frames, URLs, payloads and logged-out panels', async () => {
  let calls = 0; const m = await model;
  const f = fixture(async () => ({read:async()=>{calls++;return{settings:m.DEFAULTS};},save:async v=>v}));
  const read = f.handlers.get(READ), save = f.handlers.get(SAVE);
  assert.equal((await read({...f.event(),sender:{}})).ok,false);
  assert.equal((await read({...f.event(),senderFrame:{url:PANEL}})).ok,false);
  assert.equal((await read(f.event(),{})).ok,false);
  for (const url of ['https://chartshub.ca/','chartshub-companion://app/ui/overlay.html',PANEL+'?x',PANEL+'#x']) {
    f.contents.mainFrame.url=url; assert.equal((await read(f.event())).ok,false);
  }
  f.contents.mainFrame.url=PANEL; f.setAvailable(false); assert.equal((await read(f.event())).ok,false); f.setAvailable(true);
  assert.equal((await save(f.event(),{...m.DEFAULTS,path:'/tmp/unsafe'})).ok,false); assert.equal(calls,0);
  assert.equal((await read(f.event())).ok,true); assert.equal(calls,1); await f.controller.dispose();
});
test('IPC persistence errors never report a successful save or expose a path', async () => {
  const m = await model, f=fixture(async()=>({save:async()=>{throw Error('/private/location');}}));
  assert.deepEqual(await f.handlers.get(SAVE)(f.event(),m.DEFAULTS),{ok:false,error:'storage'}); await f.controller.dispose();
});
test('bounded writes reject concurrent requests and dispose waits for an accepted write', async () => {
  let release, entered; const started = new Promise(r=>entered=r), gate = new Promise(r=>release=r), m=await model;
  const f=fixture(async()=>({save:async v=>{entered();await gate;return v;}}));
  const save=f.handlers.get(SAVE), first=save(f.event(),m.DEFAULTS); await started;
  assert.deepEqual(await save(f.event(),m.DEFAULTS),{ok:false,error:'busy'});
  let finished=false; const done=f.controller.dispose().then(()=>finished=true); await Promise.resolve(); assert.equal(finished,false);
  release(); await done; await first; assert.equal(finished,true); assert.equal(f.handlers.size,0);
  assert.equal((await save(f.event(),m.DEFAULTS)).ok,false);
});
test('logout while a native operation is pending prevents returning settings', async () => {
  let release, entered; const start=new Promise(r=>entered=r), gate=new Promise(r=>release=r), m=await model;
  const f=fixture(async()=>({read:async()=>{entered();await gate;return{settings:m.DEFAULTS};}}));
  const task=f.handlers.get(READ)(f.event()); await start; f.setAvailable(false);release();
  assert.deepEqual(await task,{ok:false,error:'unavailable'}); await f.controller.dispose();
});
test('ready notifications only target the exact available Companion panel', async () => {
  const f=fixture(async()=>({})); f.controller.notifyReady(f.contents); assert.deepEqual(f.sent,[READY]);
  f.setAvailable(false);f.controller.notifyReady(f.contents); assert.equal(f.sent.length,1); await f.controller.dispose();
});
test('preload bridge and module injection are absent from overlay and remote pages', async () => {
  const source=await fs.readFile(path.join(__dirname,'../companion/preload.cjs'),'utf8');
  for(const href of ['https://chartshub.ca/','chartshub-companion://app/ui/overlay.html',PANEL+'?x']){
    const names=[];
    const ctx={location:new URL(href),require:()=>({contextBridge:{exposeInMainWorld:n=>names.push(n)},ipcRenderer:{}})};
    vm.runInNewContext(source,ctx); assert.equal(names.includes('ChartsHubUIBloom'),false);
  }
});
test('preload waits for shell attachment and never exposes ipcRenderer itself', async () => {
  const source=await fs.readFile(path.join(__dirname,'../companion/preload.cjs'),'utf8'), exposed={}, listeners={}, appended=[];
  const ctx={location:new URL(PANEL),process:{isMainFrame:true},document:{readyState:'complete',getElementById:()=>false,createElement:tag=>({tag}),head:{append:(...els)=>appended.push(...els)}},require:()=>({contextBridge:{exposeInMainWorld:(n,v)=>exposed[n]=v},ipcRenderer:{on:(n,f)=>listeners[n]=f,invoke:()=>{},removeListener:()=>{}}})};
  vm.runInNewContext(source,ctx); assert.equal(appended.length,0);
  assert.deepEqual(Object.keys(exposed.ChartsHubUIBloom).sort(),['read','save']);
  listeners[READY](); listeners[READY](); assert.equal(appended.length,2); assert.equal(appended[1].type,'module');
  assert.equal(appended[1].src,'chartshub-companion://app/ui/ui-bloom.js');
});
