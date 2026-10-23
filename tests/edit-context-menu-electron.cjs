'use strict';
const assert = require('node:assert/strict');

// The real main/host create these menus. Only the selection of the native item
// is automated; Chromium still supplies the actual right-click edit flags.
async function verifyNativeEditContextMenu({ contents, ownerWindow, selector, menus, clipboard, waitFor, delay }) {
  const marker = 'ChartsHub synthetic edit menu fixture';
  clipboard.writeText('ChartsHub synthetic clipboard fixture');
  const value = () => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`);
  const previous = await contents.executeJavaScript(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)}),positions=[];
    for(let node=input;node;node=node.parentElement)positions.push([node.scrollLeft,node.scrollTop]);
    return {value:input.value,positions,window:[scrollX,scrollY]};
  })()`);
  const contexts = [];
  const observeContext = (_event, params) => contexts.push({ editable: params.isEditable, frame: params.frame === contents.mainFrame, flags: params.editFlags, source: params.menuSourceType });
  contents.on('context-menu', observeContext);
  assert.equal(contents.debugger.isAttached(), false, 'editing check owns its isolated debugger');
  contents.debugger.attach('1.3');
  const cdp = (method, params) => contents.debugger.sendCommand(method, params);
  async function rightClick() {
    const before = menus.length;
    const point = await contents.executeJavaScript(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.scrollIntoView({block:'center',behavior:'instant'}); input.focus();
      const rect = input.getBoundingClientRect(); return {x:Math.round(rect.x+Math.min(20,rect.width/2)),y:Math.round(rect.y+rect.height/2)};
    })()`);
    // A tab becoming visible and scrollIntoView both invalidate native hit
    // testing. Wait for the renderer to present that layout before the mouse.
    await Promise.race([contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),delay(100)]);
    contents.focus();
    // Target this renderer directly so a host cursor or another hidden native
    // view cannot steal the event. Chromium still performs its real hit test.
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
    await waitFor(() => menus.length > before, 'native text editing popup for ' + selector).catch(async error => {
      const target = await contents.executeJavaScript(`(() => {const input=document.querySelector(${JSON.stringify(selector)}),rect=input.getBoundingClientRect();return {active:document.activeElement===input,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:document.elementFromPoint(${point.x},${point.y})?.id};})()`);
      throw new Error(error.message + '; native contexts and hit: ' + JSON.stringify({contexts,target}), {cause:error});
    });
    const entry = menus.at(-1);
    assert.equal(entry.options.window, ownerWindow);
    assert.equal(entry.options.frame, contents.mainFrame);
    assert.equal(entry.options.sourceType, 'mouse');
    assert.equal('x' in entry.options, false); assert.equal('y' in entry.options, false);
    return entry;
  }
  function choose(entry, labels) {
    const item = entry.menu.items.find(item => labels.includes(item.label));
    assert.ok(item?.enabled, 'Chromium enables ' + labels[0]);
    assert.equal(typeof item.click, 'function');
    item.click(item, ownerWindow, {});
    entry.menu.closePopup(ownerWindow);
  }
  try {
    await contents.executeJavaScript(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(marker)};input.focus();input.select(); })()`);
    choose(await rightClick(), ['Copier', 'Copy']);
    await delay(80);
    await contents.executeJavaScript(`(() => { const input=document.querySelector(${JSON.stringify(selector)});input.value='';input.focus(); })()`);
    choose(await rightClick(), ['Coller', 'Paste']);
    await waitFor(async () => (await value()) === marker, 'native Paste edits the source field ' + selector);
  } finally {
    contents.removeListener('context-menu', observeContext);
    if (contents.debugger.isAttached()) contents.debugger.detach();
    for (const entry of menus) { try { entry.menu.closePopup(ownerWindow); } catch {} }
    if (!contents.isDestroyed()) await contents.executeJavaScript(`(() => {
      const previous=${JSON.stringify(previous)},input=document.querySelector(${JSON.stringify(selector)});input.value=previous.value;
      let index=0;for(let node=input;node;node=node.parentElement){const point=previous.positions[index++];node.scrollTo({left:point[0],top:point[1],behavior:'instant'});}
      window.scrollTo({left:previous.window[0],top:previous.window[1],behavior:'instant'});
    })()`);
    clipboard.clear();
  }
}

module.exports = { verifyNativeEditContextMenu };
