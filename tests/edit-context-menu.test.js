'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachEditContextMenu } = require('../desktop/edit-context-menu.cjs');

function fixture() {
  const contents = new EventEmitter(), ownerWindow = new EventEmitter(), calls = [], menus = [];
  let allowed = true, language = 'fr', destroyed = false, closed = false;
  Object.assign(contents, { mainFrame: {}, isDestroyed: () => destroyed });
  Object.assign(ownerWindow, { isDestroyed: () => closed });
  for (const method of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) contents[method] = () => calls.push(method);
  ownerWindow.webContents = Object.fromEntries(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(method => [method, () => assert.fail('The shell must not receive editing commands')]));
  const dispose = attachEditContextMenu({ contents, ownerWindow, language: () => language, isAllowed: () => allowed,
    buildMenu(template) {
      const menu = { template, popup(options) { this.options = options; }, closePopup(window) { assert.equal(window, ownerWindow); this.closed = true; } };
      menus.push(menu); return menu;
    }
  });
  const params = (overrides = {}) => ({ frame: contents.mainFrame, isEditable: true, selectionText: '', menuSourceType: 'mouse',
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true }, ...overrides });
  return { contents, ownerWindow, calls, menus, dispose, params,
    open(overrides) { contents.emit('context-menu', {}, params(overrides)); return menus.at(-1); },
    setAllowed(value) { allowed = value; }, setLanguage(value) { language = value; },
    destroyContents() { destroyed = true; contents.emit('destroyed'); }, closeWindow() { closed = true; ownerWindow.emit('closed'); }
  };
}

test('native editing menu respects Chromium flags and sends commands to the originating view', () => {
  const f = fixture(), menu = f.open();
  assert.deepEqual(menu.template.filter(item => item.label).map(item => item.label), ['Annuler', 'Rétablir', 'Couper', 'Copier', 'Coller', 'Tout sélectionner']);
  assert.deepEqual(menu.template.filter(item => item.label).map(item => item.enabled), [false, false, false, false, true, true]);
  assert.equal(menu.options.window, f.ownerWindow); assert.equal(menu.options.frame, f.contents.mainFrame);
  assert.equal(menu.options.sourceType, 'mouse'); assert.equal('x' in menu.options, false); assert.equal('y' in menu.options, false);
  menu.template.find(item => item.label === 'Copier').click(); assert.deepEqual(f.calls, []);
  menu.template.find(item => item.label === 'Coller').click(); assert.deepEqual(f.calls, ['paste']);
  f.dispose();
});

test('all enabled edits and English labels use the source WebContents', () => {
  const f = fixture(); f.setLanguage('en');
  const menu = f.open({ editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  for (const item of menu.template) item.click?.();
  assert.deepEqual(menu.template.filter(item => item.label).map(item => item.label), ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all']);
  assert.deepEqual(f.calls, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']); f.dispose();
});

test('non-editable selections expose only Copy, and blank or unrelated frame contexts expose nothing', () => {
  const f = fixture();
  for (const overrides of [{ isEditable: false }, { frame: null }, { frame: {} }, { isEditable: false, selectionText: 'selected', editFlags: { canCopy: false } }]) f.open(overrides);
  assert.equal(f.menus.length, 0);
  const menu = f.open({ isEditable: false, selectionText: 'selected', editFlags: { canCopy: true } });
  assert.equal(menu.template.length, 1); assert.equal(menu.template[0].label, 'Copier'); menu.template[0].click(); assert.deepEqual(f.calls, ['copy']); f.dispose();
});

test('navigation closes an active menu and prevents stale commands even after returning to an allowed URL', () => {
  const f = fixture(), menu = f.open(), paste = menu.template.find(item => item.label === 'Coller');
  f.contents.emit('did-start-navigation', {}, 'https://chartshub.ca/next', false, true);
  assert.equal(menu.closed, true); paste.click(); assert.deepEqual(f.calls, []);
  const current = f.open(); current.template.find(item => item.label === 'Coller').click(); assert.deepEqual(f.calls, ['paste']); f.dispose();
});

test('new menus supersede old menus, revoked access rejects commands, and frame changes reject commands', () => {
  const f = fixture(), old = f.open(), current = f.open();
  old.template.find(item => item.label === 'Coller').click(); assert.deepEqual(f.calls, []); assert.equal(old.closed, true);
  f.setAllowed(false); current.template.find(item => item.label === 'Coller').click(); f.open(); assert.deepEqual(f.calls, []); assert.equal(f.menus.length, 2);
  f.setAllowed(true); const replacement = f.open(); f.contents.mainFrame = {};
  replacement.template.find(item => item.label === 'Coller').click(); assert.deepEqual(f.calls, []); f.dispose();
});

test('teardown closes menus and removes listeners when the view or owner window is destroyed', () => {
  for (const method of ['destroyContents', 'closeWindow', 'dispose']) {
    const f = fixture(), menu = f.open(); f[method](); f.dispose();
    assert.equal(menu.closed, true); assert.equal(f.contents.listenerCount('context-menu'), 0);
    assert.equal(f.contents.listenerCount('did-start-navigation'), 0); assert.equal(f.contents.listenerCount('destroyed'), 0); assert.equal(f.ownerWindow.listenerCount('closed'), 0);
    menu.template.find(item => item.label === 'Coller').click(); assert.deepEqual(f.calls, []);
  }
});

test('closing a native popup releases the active menu before teardown', () => {
  const f = fixture(), menu = f.open(); menu.options.callback();
  f.dispose(); assert.equal(menu.closed, undefined);
});
