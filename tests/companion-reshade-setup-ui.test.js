const test = require('node:test');
const assert = require('node:assert/strict');

test('ReShade setup install availability follows the exact reviewed plan and game closure', async () => {
  const { setupPresentation } = await import('../companion/ui/reshade-setup-controls.js');
  const setup = { state: 'ready', rootPath: 'C:\\Fixture', includeStarterEffects: false, busy: false, files: ['dxgi.dll'] };
  const source = { rootPath: setup.rootPath, running: false };
  assert.equal(setupPresentation(setup, source, false).canInstall, true);
  for (const running of [true, null, undefined]) assert.equal(setupPresentation(setup, { ...source, running }, false).canInstall, false);
  assert.equal(setupPresentation(setup, { ...source, rootPath: 'C:\\Other' }, false).canInstall, false);
  assert.match(setupPresentation(setup, source, true).note, /choix du pack a changé/);
  assert.equal(setupPresentation(setup, source, true).canInstall, false);
  for (const state of ['idle', 'preparing', 'installing', 'complete', 'error']) assert.equal(setupPresentation({ ...setup, state }, source, false).canInstall, false);
  assert.equal(setupPresentation({ ...setup, busy: true }, source, false).canInstall, false);
  const noChanges = setupPresentation({ ...setup, files: [] }, source, false);
  assert.equal(noChanges.canInstall, false); assert.equal(noChanges.label, 'Déjà installé');
});
