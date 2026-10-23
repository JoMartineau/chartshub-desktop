'use strict';
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep Chromium's hover state deterministic: native tooltip/OS mouse-leave
// events otherwise interrupt injected pointers on Windows CI. Compare actual
// geometry and hit testing at the original edge, throughout the transition.
async function verifyCatalogueHover(contents, selector) {
  const target = JSON.stringify(selector);
  const evaluate = source => contents.executeJavaScript(source);
  const saved = await evaluate(`(()=>{const h=document.documentElement;return {motion:h.dataset.chMotion,economy:h.dataset.chEconomy,lift:h.style.getPropertyValue('--ch-motion-hover-lift')};})()`);
  contents.setBackgroundThrottling(false);
  assert.equal(contents.debugger.isAttached(), false);
  contents.debugger.attach('1.3');
  const cdp = (method, params = {}) => contents.debugger.sendCommand(method, params);
  let nodeId;
  async function hover(classes) {
    const { root } = await cdp('DOM.getDocument');
    ({ nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector }));
    assert.ok(nodeId, 'catalogue action remains in the document');
    await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
  }
  try {
    await cdp('DOM.enable'); await cdp('CSS.enable');
    for (const lift of [1, 3, 5]) {
      for (const edge of ['centre', 'bottom']) {
        await hover([]);
        contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
        await evaluate(`(()=>{const h=document.documentElement;h.dataset.chMotion='off';h.dataset.chEconomy='off';h.style.setProperty('--ch-motion-hover-lift','${lift}px');document.querySelector(${target}).scrollIntoView({block:'center',behavior:'instant'});})()`);
        const bounds = await evaluate(`(()=>{const b=document.querySelector(${target});if(!b||b.disabled)throw Error('Enabled catalogue button required');const r=b.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
        const point = { x: Math.round(bounds.x + bounds.width / 2), y: edge === 'bottom' ? Math.floor(bounds.y + bounds.height - 1) : Math.round(bounds.y + bounds.height / 2) };
        await evaluate("document.documentElement.dataset.chMotion='arcade';void 0");
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        await hover(['hover']);
        for (let sample = 0; sample < 8; sample++) {
          await delay(40);
          const actual = await evaluate(`(()=>{const b=document.querySelector(${target}),r=b.getBoundingClientRect(),s=getComputedStyle(b),hit=document.elementFromPoint(${point.x},${point.y});return {x:r.x,y:r.y,width:r.width,height:r.height,hover:b.matches(':hover'),hit:hit===b||b.contains(hit),background:s.backgroundColor};})()`);
          assert.ok(actual.hover && actual.hit, `stationary ${edge} pointer remains over button (${lift}px): ${JSON.stringify(actual)}`);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - bounds[key]) < .1, `catalogue action ${key} stays stable: ${JSON.stringify(actual)}`);
          assert.match(actual.background, /^rgb\(/, 'primary action always has an opaque background');
        }
      }
    }
  } finally {
    if (nodeId) await hover([]);
    contents.debugger.detach();
    contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await evaluate(`(()=>{const h=document.documentElement,s=${JSON.stringify(saved)};for(const k of ['motion','economy']){const key=k==='motion'?'chMotion':'chEconomy';if(s[k]===undefined)delete h.dataset[key];else h.dataset[key]=s[k];}if(s.lift)h.style.setProperty('--ch-motion-hover-lift',s.lift);else h.style.removeProperty('--ch-motion-hover-lift');})()`);
  }
}
module.exports = { verifyCatalogueHover };
