'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const editorDocument = snapshot => ({ widgets: snapshot.state.widgets.instances, theme: snapshot.state.theme, stream: snapshot.state.stream });

/** Uses only the isolated profile supplied by companion-electron.cjs. */
async function verifyProfiles({ host, panel, data, passed, waitFor }) {
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const initial = structuredClone(host.snapshot()), original = editorDocument(initial);
  const previousIds = new Set(initial.profiles.items.map(item => item.id));
  const id = original.widgets.find(widget => widget.type === 'song.title')?.id;
  assert.ok(id, 'profile verification needs the title widget');
  const name = 'Native profile ' + randomUUID().slice(0, 8);
  const widget = () => host.snapshot().state.widgets.instances.find(item => item.id === id);
  const revision = () => host.snapshot().editor.revision;
  const boxSelector = `#builder-canvas [data-builder-widget-id="${id}"]`;
  const uiBefore = await evaluate("({editing:document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true',stream:document.querySelector('#preview-stream-tab').getAttribute('aria-selected')==='true'})");
  let profileId, primaryFailure;
  const command = async (name, payload) => {
    const result = await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
    assert.equal(result?.ok, true, 'profile verification command failed: ' + name);
    return result;
  };
  const paint = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const ready = selector => waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled})()`), 'profile control enabled: ' + selector);
  const point = async selector => {
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing profile interaction target');for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;node.scrollIntoView({block:'center',inline:'nearest'});})()`);
    await paint();
    return evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),rect=node.getBoundingClientRect();
      if(!rect.width||!rect.height)throw Error('Hidden profile interaction target');
      for(const [fx,fy] of [[.5,.5],[.15,.5],[.85,.5],[.5,.25],[.5,.75]]){
        const point={x:Math.round(rect.left+rect.width*fx),y:Math.round(rect.top+rect.height*fy)},hit=document.elementFromPoint(point.x,point.y);
        if(hit&&(node===hit||node.contains(hit)))return point;
      }throw Error('Covered profile interaction target: '+${JSON.stringify(selector)});
    })()`);
  };
  const mouse = (type, coordinate, modifiers = []) => panel.webContents.sendInputEvent({ type, ...coordinate, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }), modifiers });
  const click = async selector => {
    await ready(selector); const target = await point(selector);
    panel.focus(); panel.webContents.focus();
    mouse('mouseMove', target); mouse('mouseDown', target); mouse('mouseUp', target);
    await delay(50);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(50);
  };
  const setEditing = async enabled => {
    if (await evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true'") !== enabled) await click('#builder-toggle');
    await waitFor(() => evaluate(`document.querySelector('#builder-toggle').getAttribute('aria-pressed')===${JSON.stringify(String(enabled))}`), 'builder edit mode');
  };
  const profileApply = () => command('profile.apply', { revision: revision(), profilesRevision: host.snapshot().profiles.revision, id: profileId });
  const originalRestored = () => {
    try { assert.deepEqual(editorDocument(host.snapshot()), original); return true; } catch { return false; }
  };
  try {
    await ready('#profiles-create');
    await click('#profiles-name');
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
    await panel.webContents.insertText(name);
    await click('#profiles-create');
    await waitFor(() => {
      profileId = host.snapshot().profiles.items.find(item => !previousIds.has(item.id) && item.name === name)?.id;
      return !!profileId;
    }, 'named profile saved from the UI');
    const applySelector = `[data-profile-apply="${profileId}"]`;
    await ready(applySelector);
    assert.deepEqual(editorDocument(host.snapshot()), original, 'saving a profile does not modify current settings');
    const fontSize = widget().style.fontSize === 64 ? 66 : 64;
    await command('widget.fontSize', { revision: revision(), id, fontSize });
    await waitFor(() => widget().style.fontSize === fontSize && host.snapshot().profiles.activeId !== profileId, 'font edit marks the saved profile inactive');
    await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(applySelector)}).closest('.profile-item').classList.contains('is-active')`), 'profile UI receives the edit revision');
    await click(applySelector);
    await waitFor(() => originalRestored() && host.snapshot().profiles.activeId === profileId, 'one profile click restores the complete saved editor settings');
    passed.push('native profile controls save a named profile and one click restores font size, colors, game/stream geometry and widget settings');

    await setEditing(true);
    await click('#preview-game-tab');
    await click(`#builder-list [data-select-widget-id="${id}"]`);
    await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(boxSelector)}).getAttribute('aria-selected')==='true'&&!document.querySelector('#builder-locked').disabled`), 'title selected in builder inspector');
    if (widget().locked === true) {
      await click('#builder-locked');
      await waitFor(() => widget().locked !== true, 'initially locked fixture unlocked for the test');
    }
    await ready('#builder-locked');
    await click('#builder-locked');
    await waitFor(() => widget().locked === true, 'inspector checkbox locks the selected widget');
    await waitFor(() => evaluate(`(()=>{const box=document.querySelector(${JSON.stringify(boxSelector)});return box.classList.contains('is-locked')&&!box.querySelector('[data-resize-handle]')&&['x','y','width','height'].every(key=>document.querySelector('#builder-'+key).disabled)&&document.querySelector('#builder-locked').checked&&!document.querySelector('#builder-locked').disabled&&!document.querySelector('#builder-visible-game').disabled})()`), 'locked geometry is disabled while unlock and visibility stay available');
    const lockedDocument = structuredClone(editorDocument(host.snapshot())), lockedRevision = revision();
    const start = await point(boxSelector), scale = await evaluate("document.querySelector('#builder-canvas').getBoundingClientRect().width/1280");
    panel.focus(); panel.webContents.focus();
    mouse('mouseMove', start); mouse('mouseDown', start);
    for (let step = 1; step <= 3; step++) {
      mouse('mouseMove', { x: Math.round(start.x + 32 * scale * step / 3), y: Math.round(start.y + 16 * scale * step / 3) }, ['leftButtonDown']);
      await delay(30);
    }
    mouse('mouseUp', { x: Math.round(start.x + 32 * scale), y: Math.round(start.y + 16 * scale) });
    await key('ArrowRight'); await paint(); await delay(150);
    assert.equal(revision(), lockedRevision, 'locked pointer drag and arrow key must not commit layout changes');
    assert.deepEqual(editorDocument(host.snapshot()), lockedDocument);
    await click('#preview-stream-tab');
    await waitFor(() => evaluate(`document.querySelector('#builder-canvas').dataset.destination==='stream'&&document.querySelector(${JSON.stringify(boxSelector)}).classList.contains('is-locked')&&document.querySelector('#builder-x').disabled&&document.querySelector('#builder-locked').checked`), 'the same widget stays locked in stream layout');
    await evaluate("document.querySelector('#builder-canvas').focus({preventScroll:true})");
    await key('ArrowRight'); await paint();
    assert.equal(revision(), lockedRevision, 'the shared lock also blocks stream arrow movement');
    assert.deepEqual(editorDocument(host.snapshot()), lockedDocument);
    await point('#builder-locked');
    await fs.writeFile(path.join(data, 'companion-profiles-locked.png'), (await panel.webContents.capturePage()).toPNG());
    passed.push('native locked widgets stay selectable, hide resize handles and reject pointer/arrow movement in both game and stream editing');

    await click('#preview-game-tab');
    await click('#builder-locked');
    await waitFor(() => widget().locked !== true && !panel.isDestroyed(), 'widget unlocked from the inspector');
    await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(boxSelector)}).querySelectorAll('[data-resize-handle]').length===8&&['x','y','width','height'].every(key=>!document.querySelector('#builder-'+key).disabled)`), 'unlock restores eight handles and numeric geometry inputs');
    const x = widget().position.x;
    // Focusing the canvas avoids arrow-key changes to an inspector input.
    await evaluate("document.querySelector('#builder-canvas').focus({preventScroll:true})");
    await key(x > 0 ? 'ArrowLeft' : 'ArrowRight');
    await waitFor(() => widget().position.x !== x, 'unlocked arrow movement commits normally');
    await ready(applySelector); await click(applySelector);
    await waitFor(originalRestored, 'profile reapplied after the lock test');
    await click(`[data-profile-select="${profileId}"]`);
    await click('#profiles-delete');
    assert.equal(host.snapshot().profiles.items.some(item => item.id === profileId), true, 'delete requires confirmation');
    await click('#profiles-delete-confirm');
    await waitFor(() => !host.snapshot().profiles.items.some(item => item.id === profileId), 'only the temporary native profile is deleted');
    assert.deepEqual(editorDocument(host.snapshot()), original, 'deleting a profile keeps the restored layout and style');
    assert.deepEqual(host.snapshot().profiles.items.map(item => item.id).sort(), [...previousIds].sort());
    passed.push('native unlock restores geometry controls and movement; deleting the temporary profile requires confirmation and preserves the restored settings');
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    const failures = [];
    if (!panel.isDestroyed()) {
      try {
        if (profileId && host.snapshot().profiles.items.some(item => item.id === profileId)) {
          await profileApply();
          await command('profile.delete', { profilesRevision: host.snapshot().profiles.revision, id: profileId });
        }
        assert.deepEqual(editorDocument(host.snapshot()), original);
        await setEditing(uiBefore.editing);
        await click(uiBefore.stream ? '#preview-stream-tab' : '#preview-game-tab');
        await host.saveSettings();
      } catch { failures.push('restore initial editor settings and remove temporary profile'); }
    }
    if (failures.length && !primaryFailure) throw Error('Profile verification cleanup failed: ' + failures.join(', '));
  }
}

module.exports = { verifyProfiles };
