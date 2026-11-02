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

test('Input Viewer output actions accept only positioning flags and cannot supply URLs, bounds or inputs', () => {
  for (const command of ['inputViewer.copyUrl', 'inputViewer.hideOutput', 'inputViewer.stop']) {
    for (const payload of [undefined, null, {}]) assert.equal(validCommand(command, payload, []), true);
    for (const payload of [[], true, { url: 'http://127.0.0.1:1/' }, { token: 'secret' }, { inputs: {} }]) assert.equal(validCommand(command, payload, []), false);
  }
  for (const editing of [true, false]) {
    assert.equal(validCommand('inputViewer.showOutput', { editing }, []), true);
    for (const alwaysOnTop of [true, false]) assert.equal(validCommand('inputViewer.showOutput', { editing, alwaysOnTop }, []), true);
  }
  for (const payload of [undefined, null, {}, [], { editing: 1 }, { alwaysOnTop: true }, { editing: true, alwaysOnTop: 'yes' }, { editing: true, x: 0 }, { editing: false, width: 9999 }, { editing: true, url: 'https://other.test/' }]) assert.equal(validCommand('inputViewer.showOutput', payload, []), false);
  for (const page of ['filters-widget.html', 'catalogue-widget.html']) {
    const contents = { mainFrame: { url: 'chartshub-companion://app/ui/' + page } };
    const window = { isDestroyed: () => false, webContents: contents };
    const event = { sender: contents, senderFrame: contents.mainFrame };
    for (const [name, payload] of [['inputViewer.copyUrl', {}], ['inputViewer.showOutput', { editing: true }], ['inputViewer.hideOutput', {}], ['inputViewer.stop', {}]]) {
      assert.equal(trustedFiltersWidgetCommand(event, window, name, payload), false);
      assert.equal(trustedCatalogueWidgetCommand(event, window, name, payload), false);
    }
  }
});
