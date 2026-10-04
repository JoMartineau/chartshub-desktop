'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const { createReShadeService } = require('../companion/reshade-service.cjs');

// Real service + host + renderers; fake files and transport only, never the user's game.
const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'reshade-stability-verification'));
const game = path.join(directory, 'fake-game');
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
registerCompanionScheme();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); }
function executable() { const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80); bytes.writeUInt16LE(0x8664, 0x84); return bytes; }
let host, service, delayedProbe = null, gameRunning = true, releaseProbe = null;
const passed = [];
const observe = draft => `(()=>{
  const field=document.querySelector('[data-uniform-id="1:u:1"] input[type=number]');
  const technique=document.querySelector('[data-technique-id="1:t:1"]');
  const status=document.querySelector('#reshade-status');
  const install=document.querySelector('#reshade-install');
  field.focus();field.value=${JSON.stringify(String(draft))};
  window.__stability={field,technique,label:status.textContent,install:install?.textContent,glitches:[]};
  window.__stability.observer=new MutationObserver(()=>{
    const current=document.querySelector('#reshade-status').textContent;
    const disabled=document.querySelector('#reshade-enabled').disabled;
    if(current!==window.__stability.label||disabled||(install&&install.textContent!==window.__stability.install))window.__stability.glitches.push({current,disabled,install:install?.textContent});
  });
  window.__stability.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
})()`;
const verify = draft => `(()=>{const s=window.__stability;return {
  label:document.querySelector('#reshade-status').textContent,
  enabled:!document.querySelector('#reshade-enabled').disabled,
  checked:document.querySelector('[data-technique-id="1:t:1"] input').checked,
  sameTechnique:s.technique===document.querySelector('[data-technique-id="1:t:1"]'),
  sameField:s.field===document.querySelector('[data-uniform-id="1:u:1"] input[type=number]'),
  focused:document.activeElement===s.field,
  draft:s.field.value===${JSON.stringify(String(draft))},glitches:s.glitches
}})()`;

app.whenReady().then(async () => {
  await fs.mkdir(game, { recursive: true });
  const binary = path.join(directory, 'fixture.addon64'), bytes = Buffer.from('addon fixture; never loaded');
  await fs.writeFile(binary, bytes);
  await fs.writeFile(path.join(game, 'Clone Hero.exe'), executable());
  await fs.writeFile(path.join(game, 'UnityPlayer.dll'), 'fixture; never loaded');
  await fs.writeFile(path.join(game, 'dxgi.dll'), 'ReShadeRegisterAddon fixture; never loaded');
  await fs.writeFile(path.join(game, 'ReShade.ini'), '[GENERAL]\nPresetPath=Fixture.ini\n');
  await fs.writeFile(path.join(game, 'ChartsHubReShade.addon64'), bytes);
  await fs.writeFile(path.join(game, 'ChartsHubReShade.install.json'), JSON.stringify({ version: 1, phase: 'installed', moduleHash: createHash('sha256').update(bytes).digest('hex') }));
  const base = { protocol: 1, pid: 42424, executablePath: path.join(game, 'Clone Hero.exe'), generation: 1, runtimeReady: true, effectsEnabled: true, presetName: 'Fixture.ini' };
  const technique = { id: '1:t:1', name: 'Bloom', label: 'Bloom', effect: 'Bloom.fx', enabled: true };
  const uniform = { id: '1:u:1', name: 'Strength', label: 'Intensité', effect: 'Bloom.fx', type: 'float', value: [.5], min: [0], max: [1], step: [.01], components: 1, rows: 1, columns: 1, arrayLength: 0, uiType: 'slider', items: [], tooltip: '', readOnly: false };
  service = createReShadeService({ dataDirectory: directory, initialRoot: game, addonBinaryPath: binary, platform: 'win32',
    probeGame: async () => { if (delayedProbe) { const pause = delayedProbe; delayedProbe = null; await pause(); } return gameRunning ? { running: true, sessions: [{ pid: base.pid }] } : { running: false, sessions: [] }; },
    transport: async (_pid, request) => request.action === 'uniforms' ? { ...base, effect: 'Bloom.fx', uniforms: [uniform] } : { ...base, techniques: [technique] },
    onChange: () => { if (host) host.services.store.setState(state => ({ ...state })); }
  });
  host = await createCompanionHost({ dataDirectory: directory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }), reshadeService: service });
  const panel = await host.open(); const evaluate = code => panel.webContents.executeJavaScript(code);
  await evaluate("window.ChartsHubCompanion.command('reshade.command',{action:'selectEffect',effect:'Bloom.fx'})");
  await waitFor(() => evaluate("!!document.querySelector('[data-uniform-id=\"1:u:1\"] input[type=number]')"), 'selected parameter rendered');
  await host.setFiltersWidget(true); const widget = host.getFiltersWidget(); const mini = code => widget.webContents.executeJavaScript(code);
  await waitFor(() => mini("!!document.querySelector('[data-uniform-id=\"1:u:1\"] input[type=number]')"), 'widget parameter rendered');
  await evaluate(observe(.63)); await mini(observe(.72));

  for (let round = 0; round < 3; round++) {
    let entered; const blocked = new Promise(resolve => { entered = resolve; });
    delayedProbe = () => { entered(); return new Promise(resolve => { releaseProbe = resolve; }); };
    const refresh = service.refresh();
    await blocked;
    // This is the same unrelated store broadcast that exposed in-progress service state in production.
    for (let broadcast = 0; broadcast < 3; broadcast++) {
      host.services.store.setState(state => ({ ...state }));
      await delay(25);
      for (const [label, inspect, draft] of [['panel', evaluate, .63], ['widget', mini, .72]]) {
        const state = await inspect(verify(draft));
        assert.deepEqual(state, { label: 'ReShade connecté · effets activés', enabled: true, checked: true, sameTechnique: true, sameField: true, focused: true, draft: true, glitches: [] }, `${label} must preserve text, activation, nodes, focus and unsaved draft while inspection is pending`);
      }
    }
    releaseProbe(); releaseProbe = null; await refresh;
  }
  passed.push('three delayed real-service refreshes plus nine unrelated host broadcasts preserve main and mini text, installation labels, checkbox states, DOM identity, focus and numeric drafts');
  await evaluate('window.__stability.observer.disconnect()'); await mini('window.__stability.observer.disconnect()');
  gameRunning = false; await service.refresh();
  await waitFor(() => evaluate("document.querySelector('#reshade-enabled').disabled&&document.querySelectorAll('#reshade-techniques .reshade-technique').length===0"), 'real disconnection is committed to main panel');
  await waitFor(() => mini("document.querySelector('#reshade-enabled').disabled&&document.querySelectorAll('#reshade-techniques .reshade-technique').length===0"), 'real disconnection is committed to widget');
  passed.push('a completed probe confirming game closure still disables and clears both renderers promptly');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: true, passed }, null, 2));
}).catch(async error => {
  process.exitCode = 1; await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: false, error: error.stack, passed }, null, 2));
}).finally(async () => { releaseProbe?.(); await host?.dispose(); await service?.dispose(); app.exit(process.exitCode || 0); });
