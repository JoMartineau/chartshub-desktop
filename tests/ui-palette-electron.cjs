'use strict';
// Real main process, preloads, shell and Companion; all network responses,
// account state, telemetry discovery and files are disposable fixture data.
require('./setup.cjs');
const electron = require('electron'), { app, session } = electron;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), Module = require('node:module');
// Electron initializes its Node search paths before inheriting this fixture's
// dependency location; refresh them for isolated checkouts without npm install.
if (process.env.NODE_PATH) Module._initPaths();
const root = path.resolve(__dirname, '..'), directory = path.resolve(process.argv[2]);
const restart = process.argv.includes('--restart');
if (!process.argv[2] || directory === root || !path.basename(directory).startsWith('ui-palette-')) throw Error('Provide a disposable ui-palette-* output directory');
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
const nativeFile = path.join(app.getPath('userData'), 'companion/ui-bloom.json');
const legacy = { version: 1, enabled: true, color: '#00ff11', intensity: 65, radius: 4, blur: 32, opacity: 65, economy: false };
if (!restart) { fs.mkdirSync(path.dirname(nativeFile), { recursive: true }); fs.writeFileSync(nativeFile, JSON.stringify(legacy)); }
let desktop, host, failing = false, exportGate = null, exportEntered = null, rejectedPalettes = 0;
const passed = [], knownLimitations = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) { passed.push(label); return; } await delay(40); }
  throw Error('Timed out: ' + label);
}
async function fail(error) {
  if (failing) return; failing = true; console.error(error.stack || error);
  fs.writeFileSync(path.join(directory, restart ? 'restart-failure.txt' : 'failure.txt'), String(error.stack || error));
  try {
    const local = host?.getPanelContents();
    fs.writeFileSync(path.join(directory, 'failure-state.json'), JSON.stringify({ passed, host: host?.snapshot().uiPalette, local: local && !local.isDestroyed() ? await local.executeJavaScript(`({palette:document.documentElement.dataset.chCataloguePalette,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent'),bloom:document.documentElement.style.getPropertyValue('--ch-bloom-color'),follow:window.ChartshubBloom?.read().followCatalogue})`) : null }, null, 2));
  } catch {}
  try { await host?.dispose(); await desktop?.dispose(); } catch {}
  app.exit(1);
}
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
setTimeout(() => fail(Error('UI palette native fixture timed out')), 120000).unref();
const originalLoad = Module._load;
Module._load = function(name, parent) {
  const result = originalLoad.apply(this, arguments);
  if (!parent?.filename.startsWith(root)) return result;
  if (name === 'electron') return { ...result, BrowserWindow: function(options) { const win = new result.BrowserWindow({ ...options, show: false }); win.show = win.showInactive = win.focus = () => {}; return win; } };
  if (name === './desktop/controller.cjs') return { ...result, createDesktopShell(options) { desktop = result.createDesktopShell(options); return desktop; } };
  if (name === './companion/clonehero-process.cjs') return { ...result, createCloneHeroProcessProbe: () => async () => ({ running: false, sessions: [] }) };
  if (name === './desktop/ui-palette.cjs') return { ...result, createUIPaletteIpc(options) { return result.createUIPaletteIpc({ ...options, allowedSender(event) { const allowed = options.allowedSender(event); if (!allowed) rejectedPalettes++; return allowed; } }); } };
  if (name === './companion/host.cjs') return { ...result, async createCompanionHost(options) {
    host = await result.createCompanionHost({ ...options, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }), catalogueClient: { load: async () => ({ items: [], demo: false, revision: 'palette-fixture' }), artwork: async () => null } });
    const flush = host.flushPortableConfiguration;
    host.flushPortableConfiguration = async () => { await flush(); if (exportGate) { exportEntered?.(); await exportGate; } };
    return host;
  } };
  return result;
};
const page = `<!doctype html><html lang="fr" data-theme="dark"><head><meta charset="utf-8"><style>
:root{--blue:#a16cff;--purple:#49bbff;--bg:#090e19;--panel:#111c2e;--panel2:#18263c;--white:#eef4ff;--muted:#9db2d0;--line:#2d4059;--ch-season-a:#ffb77c;--ch-season-b:#bfa4ff}
body{background:var(--bg);color:var(--white)}.button-primary{background:var(--blue)}</style></head><body><div class="theme-topbar"></div><main><h1>Palette fixture</h1><button class="button-primary">Action</button></main><script>
window.fixturePalette=function(mode,season='halloween',save=true){const root=document.documentElement,follow=mode!=='custom';root.dataset.chBloomFollowSeason=String(follow);if(season)root.dataset.chSeasonal=season;else delete root.dataset.chSeasonal;root.style.setProperty('--ch-season-a',season==='christmas'?'#b0efcd':'#ffb77c');root.style.setProperty('--ch-season-b',season==='christmas'?'#f4b3ba':'#bfa4ff');root.style.setProperty('--ch-bloom-color',follow&&season?'var(--ch-season-a)':'#00ff11');if(save)localStorage.setItem('chartshub:ui-bloom:v1',JSON.stringify({version:1,followSeason:follow,color:'#00ff11'}));};
const restored=JSON.parse(localStorage.getItem('chartshub:ui-bloom:v1')||'null');fixturePalette(restored?.followSeason===false?'custom':'season','halloween',false);
</script></body></html>`;
app.whenReady().then(() => {
  session.fromPartition('persist:chartshub').protocol.handle('https', request => new URL(request.url).pathname === '/api/auth/me'
    ? Response.json({ user: { id: 'disposable-palette-member', emailVerified: false, staffRole: null } }) : new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
});
electron.dialog.showErrorBox = (title, message) => { throw Error(title + ': ' + message); }; electron.dialog.showMessageBox = async () => ({ response: 0 });
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(directory, 'maintenance-backup.json') });
require('../main.js');
app.whenReady().then(async () => {
  await waitFor(() => desktop, 'desktop constructed'); await desktop.ready;
  const frame = desktop.window.webContents, web = desktop.catalogueView.webContents;
  const state = () => frame.executeJavaScript('window.chartsHubShell.getState()');
  await waitFor(() => web.getURL() === 'https://chartshub.ca/' && !web.isLoading(), 'trusted Catalogue loaded');
  await waitFor(async () => (await state()).companionAvailable, 'normal fixture account authorization');
  await frame.executeJavaScript('window.chartsHubShell.selectTab("companion")');
  await waitFor(() => host?.getPanelContents() && !host.getPanelContents().isLoading(), 'local Companion ready');
  const local = host.getPanelContents(); local.setBackgroundThrottling(false);
  await waitFor(() => local.executeJavaScript('!!window.ChartshubBloom&&!document.querySelector("#ch-bloom-open").disabled'), 'native appearance module ready');
  const painted = () => local.executeJavaScript(`({accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),bloom:document.documentElement.style.getPropertyValue('--ch-bloom-color'),mode:document.documentElement.dataset.chCataloguePalette,shadow:document.documentElement.style.getPropertyValue('--ch-bloom-shadow'),personal:window.ChartshubBloom.read().color,follow:window.ChartshubBloom.read().followCatalogue})`);
  const expect = async (accent, bloom, label) => waitFor(async () => { const p = await painted(); return p.accent === accent && p.bloom === bloom; }, label);
  const edit = code => local.executeJavaScript(code + ';true');
  const capture = async name => {
    // Windows needs a composited native surface for child-view screenshots.
    // Display only this disposable fixture off screen, without taking focus.
    const win = desktop.window;
    win.setBounds({ ...win.getBounds(), x: -20000, y: -20000 });
    electron.BrowserWindow.prototype.showInactive.call(win); await delay(250);
    fs.writeFileSync(path.join(directory, name + '.png'), (await local.capturePage()).toPNG());
  };
  const open = async () => { await edit('window.ChartshubBloom.open()'); await waitFor(() => local.executeJavaScript('document.querySelector("#ch-bloom-dialog").open&&!document.querySelector("#ch-bloom-apply").disabled'), 'appearance dialog loaded'); };
  const choose = async (mode, save) => {
    await edit(`document.querySelector('#ch-bloom-palette-mode').value=${JSON.stringify(mode)};document.querySelector('#ch-bloom-palette-mode').dispatchEvent(new Event('change'))`);
    if (save) { await edit('document.querySelector(".ch-bloom-form").requestSubmit()'); await waitFor(() => local.executeJavaScript(`!document.querySelector('#ch-bloom-apply').disabled&&window.ChartshubBloom.read().followCatalogue===${mode === 'catalogue'}`), 'local palette choice saved'); }
  };
  const close = async () => { await edit('document.querySelector("#ch-bloom-cancel").click()'); await waitFor(() => local.executeJavaScript('!document.querySelector("#ch-bloom-dialog").open'), 'appearance dialog closed'); await delay(80); };
  const visualState = () => { const { widgets, theme, stream } = host.snapshot().state; return JSON.stringify({ widgets, theme, stream }); };
  const widgetBefore = visualState(), editorBefore = host.snapshot().editor.revision;
  if (restart) {
    const p = await painted(); assert.equal(p.follow, true); assert.equal(p.personal, '#00ff11');
    await expect('#a16cff', '#00ff11', 'new process restores Catalogue custom choice and Companion follow preference');
    assert.equal((await state()).uiPalette.paletteMode, 'custom');
  } else {
    await expect('#ffb77c', '#ffb77c', 'legacy green Companion bloom follows Halloween orange');
    await capture('companion-follows-halloween');
    assert.equal(fs.readFileSync(nativeFile, 'utf8'), JSON.stringify(legacy), 'palette relay never migrates or rewrites personal settings');
    assert.equal((await painted()).personal, '#00ff11'); assert.equal((await painted()).follow, true);
    assert.equal((await state()).uiPalette.colors.accent, '#ffb77c');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.querySelector("#companion-tab")).getPropertyValue("--accent").trim()'), '#ffb77c');
    let releaseExport;
    exportGate = new Promise(done => { releaseExport = done; });
    const exportStarted = new Promise(done => { exportEntered = done; });
    const exportTask = local.executeJavaScript('window.ChartsHubMaintenance.invoke("backup.export")');
    await exportStarted;
    const rejectedBefore = rejectedPalettes;
    await web.executeJavaScript('fixturePalette("custom")');
    await waitFor(() => rejectedPalettes > rejectedBefore, 'maintenance lock rejects palette update');
    assert.equal(host.snapshot().uiPalette.colors.accent, '#ffb77c');
    releaseExport(); exportGate = null; const exported = await exportTask;
    // The existing portable backup allowlist predates gameplay/lyrics widgets.
    // Its failure must still release maintenance and resume appearance updates.
    assert.ok(exported.ok || exported.error === 'BACKUP_UNSUPPORTED_WIDGET', JSON.stringify(exported));
    if (!exported.ok) knownLimitations.push('Existing backup export rejects canonical gameplay/lyrics widget types (BACKUP_UNSUPPORTED_WIDGET).');
    await expect('#a16cff', '#00ff11', 'maintenance unlock resumes unchanged palette without another DOM edit');
    await web.executeJavaScript('fixturePalette("custom")');
    await expect('#a16cff', '#00ff11', 'Catalogue custom accent and independent bloom both reach Companion');
    await web.executeJavaScript('fixturePalette("season","christmas")');
    await expect('#b0efcd', '#b0efcd', 'active holiday change updates hidden Catalogue and visible Companion');
    await web.executeJavaScript('fixturePalette("season",null)');
    await expect('#a16cff', '#00ff11', 'disabled or inactive holiday falls back to personal site colors');
    await web.executeJavaScript('fixturePalette("season")'); await expect('#ffb77c', '#ffb77c', 'holiday palette restored');
    const luminance = value => value.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const contrast = (ink, background) => (Math.max(luminance(ink), luminance(background)) + .05) / (Math.min(luminance(ink), luminance(background)) + .05);
    frame.debugger.attach('1.3');
    await frame.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await frame.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await frame.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    for (const hue of ['#000000', '#ffffff']) {
      await web.executeJavaScript(`document.documentElement.style.setProperty('--ch-season-a',${JSON.stringify(hue)});document.documentElement.style.setProperty('--ch-season-b','#ffffff')`);
      await expect(hue, hue, 'extreme holiday hue reaches Companion: ' + hue);
      await waitFor(() => frame.executeJavaScript(`document.documentElement.style.getPropertyValue('--accent')===${JSON.stringify(hue)}`), 'extreme hue reaches shell: ' + hue);
      const ink = await frame.executeJavaScript(`(()=>{const tab=document.querySelector('#companion-tab');tab.focus();const css=getComputedStyle(tab);return {text:css.color,focus:css.outlineColor,visible:tab.matches(':focus-visible'),accent:document.documentElement.style.getPropertyValue('--accent')};})()`);
      assert.equal(ink.accent, hue); assert.equal(ink.visible, true);
      for (const color of [ink.text, ink.focus]) {
        const foreground = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number), nav = [17, 28, 46], accent = hue === '#000000' ? 0 : 255;
        assert.ok(contrast(foreground, nav) >= 4.5, 'navigation focus contrast');
        for (let point = 0; point <= 100; point++) { const background = nav.map(v => (v * .9 + accent * .1) * (1 - point / 100) + (v * .92 + 255 * .08) * point / 100); assert.ok(contrast(foreground, background) >= 4.5, 'selected tab text/focus contrast'); }
      }
      passed.push('selected shell text and keyboard focus meet 4.5:1 for ' + hue);
    }
    frame.debugger.detach();
    await web.executeJavaScript('fixturePalette("season")'); await expect('#ffb77c', '#ffb77c', 'holiday colors restored after contrast checks');
    await open();
    await capture('companion-follow-colors-dialog');
    assert.equal(await local.executeJavaScript('document.querySelector("#ch-bloom-color").disabled'), true);
    await choose('custom', true); await close();
    await expect('#48c7fa', '#00ff11', 'explicit Companion personal override preserves original personal green');
    assert.equal(JSON.parse(fs.readFileSync(nativeFile, 'utf8')).followCatalogue, false);
    local.reload(); await waitFor(() => !local.isLoading(), 'Companion reloaded');
    await waitFor(() => local.executeJavaScript('!!window.ChartshubBloom&&window.ChartshubBloom.read().followCatalogue===false'), 'personal override restored after renderer reload');
    await expect('#48c7fa', '#00ff11', 'reload retains local personal palette');
    await open(); await choose('catalogue', false); await expect('#ffb77c', '#ffb77c', 'follow preview paints current Catalogue'); await close();
    await expect('#48c7fa', '#00ff11', 'Cancel restores personal palette');
    await open(); await choose('catalogue', true); await close();
    await expect('#ffb77c', '#ffb77c', 'saved follow choice paints current Catalogue');
    await web.executeJavaScript('fixturePalette("custom")'); await expect('#a16cff', '#00ff11', 'custom Catalogue choice persisted before restart');
    assert.equal(JSON.parse(fs.readFileSync(nativeFile, 'utf8')).color, '#00ff11');
    assert.equal(host.snapshot().editor.revision, editorBefore); assert.equal(visualState(), widgetBefore, 'UI palette does not edit game or stream configuration');
  }
  const report = { result: 'UI_PALETTE_NATIVE_OK', restart, passed, knownLimitations, file: nativeFile, isolatedProfile: app.getPath('userData') };
  fs.writeFileSync(path.join(directory, restart ? 'restart-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await host.dispose(); await desktop.dispose(); app.exit(0);
}).catch(fail);
