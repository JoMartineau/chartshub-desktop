'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validCommand, trustedFiltersWidgetCommand, trustedCatalogueWidgetCommand } = require('../companion/security.cjs');
const rules = { maxDurationMinutes: null, instrument: 'all', difficulty: 'all' }, id = '11111111-1111-4111-8111-111111111111';
test('Song Request IPC accepts complete bounded rules and opaque request IDs, never filesystem or network targets', () => {
  assert.equal(validCommand('songRequests.configure', { enabled: true, port: 38474, rules }, []), true);
  for (const patch of [{ port: 0 }, { port: 65536 }, { port: 1024.5 }, { enabled: 'true' }, { url: 'http://evil.invalid' }, { path: 'C:/Songs' }, { rules: {} }, { rules: { ...rules, maxDurationMinutes: 0 } }, { rules: { ...rules, instrument: 'unknown' } }, { rules: { ...rules, difficulty: 'impossible' } }, { rules: { ...rules, root: 'outside' } }]) assert.equal(validCommand('songRequests.configure', { enabled: true, port: 38474, rules, ...patch }, []), false);
  for (const action of ['accept', 'reject', 'played']) {
    assert.equal(validCommand('songRequests.' + action, { id }, []), true);
    for (const payload of [{ id, path: 'elsewhere' }, { id: '../notes.chart' }, {}, []]) assert.equal(validCommand('songRequests.' + action, payload, []), false);
  }
  assert.equal(validCommand('songRequests.move', { id, direction: 'up' }, []), true);
  assert.equal(validCommand('songRequests.move', { id, direction: 'left' }, []), false);
  for (const action of ['copyBridgeConfiguration', 'copyOverlayUrl', 'resetOrder', 'publishLibrary', 'copyLibraryUrl', 'removeLibrary']) {
    assert.equal(validCommand('songRequests.' + action, {}, []), true);
    assert.equal(validCommand('songRequests.' + action, { songs: [] }, []), false);
  }
});
test('Catalogue and filter mini windows cannot administer, publish or obtain Song Request capabilities', () => {
  for (const [page, authorize] of [['catalogue-widget.html', trustedCatalogueWidgetCommand], ['filters-widget.html', trustedFiltersWidgetCommand]]) {
    const frame = { url: 'chartshub-companion://app/ui/' + page }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
    for (const action of ['configure', 'accept', 'move', 'copyBridgeConfiguration', 'copyOverlayUrl', 'publishLibrary', 'removeLibrary', 'copyLibraryUrl']) assert.equal(authorize({ sender: contents, senderFrame: frame }, window, 'songRequests.' + action, {}), false);
  }
});
