'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validCommand, trustedFiltersWidgetCommand, trustedCatalogueWidgetCommand } = require('../companion/security.cjs');

test('Input Viewer opens only through an empty main-panel action, never renderer device or executable parameters', () => {
  for (const payload of [undefined, null, {}]) assert.equal(validCommand('inputViewer.open', payload, []), true);
  for (const payload of [true, [], { start: true }, { source: 'keyboard' }, { device: 0 }, { path: 'C:/game' }, { url: 'https://other.test' }]) {
    assert.equal(validCommand('inputViewer.open', payload, []), false);
  }
  for (const command of ['inputViewer.start', 'inputViewer.sample', 'inputViewer.keyboard', 'inputViewer.execute']) assert.equal(validCommand(command, {}, []), false);
  const contents = { mainFrame: { url: 'chartshub-companion://app/ui/filters-widget.html' } };
  const window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(trustedFiltersWidgetCommand(event, window, 'inputViewer.open', {}), false);
  contents.mainFrame.url = 'chartshub-companion://app/ui/catalogue-widget.html';
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'inputViewer.open', {}), false);
});
