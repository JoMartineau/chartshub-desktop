'use strict';
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep Chromium's styling state deterministic: native tooltip/OS mouse-leave
// events otherwise interrupt injected pointers on Windows CI. CDP's forced
// pseudo state applies CSS but is not reported by Element.matches(':hover').
// Verify the real hover style, geometry and hit testing at the original edge.
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
    // A catalogue result can render before the status snapshot that follows
    // its IPC reply. Do not attach a pseudo state to a node about to be replaced.
    await evaluate(`(async()=>{const end=Date.now()+10000;let button=null,stableAt=0;while(Date.now()<end){const current=document.querySelector(${target});const ready=current&&!current.disabled&&document.querySelector('#catalogue-results')?.getAttribute('aria-busy')==='false';if(!ready||current!==button){button=ready?current:null;stableAt=Date.now();}else if(Date.now()-stableAt>=250)return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Catalogue button did not settle before hover verification');})()`);
    const expectedHover = await evaluate(`(()=>{const probe=document.createElement('span');probe.style.cssText='position:fixed;display:none;background:var(--accent-hover)';document.body.append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;})()`);
    assert.match(expectedHover, /^rgb\(/, 'the configured hover color is opaque');
    for (const lift of [1, 3, 5]) {
      for (const edge of ['centre', 'bottom']) {
        await hover([]);
        contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
        await evaluate(`(()=>{const h=document.documentElement;h.dataset.chMotion='off';h.dataset.chEconomy='off';h.style.setProperty('--ch-motion-hover-lift','${lift}px');document.querySelector(${target}).scrollIntoView({block:'center',behavior:'instant'});})()`);
        const bounds = await evaluate(`(()=>{const b=document.querySelector(${target});if(!b||b.disabled)throw Error('Enabled catalogue button required');window.__catalogueHoverTarget=b;const r=b.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
        const point = { x: Math.round(bounds.x + bounds.width / 2), y: edge === 'bottom' ? Math.floor(bounds.y + bounds.height - 1) : Math.round(bounds.y + bounds.height / 2) };
        await evaluate("document.documentElement.dataset.chMotion='arcade';void 0");
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        await hover(['hover']);
        for (let sample = 0; sample < 8; sample++) {
          await delay(40);
          const actual = await evaluate(`(()=>{const b=document.querySelector(${target});if(!b)return {sameNode:false,missing:true};const r=b.getBoundingClientRect(),s=getComputedStyle(b),hit=document.elementFromPoint(${point.x},${point.y});return {x:r.x,y:r.y,width:r.width,height:r.height,sameNode:b===window.__catalogueHoverTarget,nativeHover:b.matches(':hover'),hit:hit===b||b.contains(hit),background:s.backgroundColor,backgroundImage:s.backgroundImage,translate:s.translate};})()`);
          assert.equal(actual.sameNode, true, `catalogue action is not replaced during hover: ${JSON.stringify(actual)}`);
          assert.ok(actual.hit, `stationary ${edge} pointer remains over button (${lift}px): ${JSON.stringify(actual)}`);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - bounds[key]) < .1, `catalogue action ${key} stays stable: ${JSON.stringify(actual)}`);
          assert.match(actual.background, /^rgb\(/, 'primary action always has an opaque background');
          assert.equal(actual.backgroundImage, 'none', `hover CSS replaces the normal gradient: ${JSON.stringify(actual)}`);
          if (sample === 7) assert.equal(actual.background, expectedHover, 'the real hover color is applied after the transition');
        }
      }
    }
  } finally {
    if (nodeId) await hover([]);
    contents.debugger.detach();
    contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await evaluate(`(()=>{delete window.__catalogueHoverTarget;const h=document.documentElement,s=${JSON.stringify(saved)};for(const k of ['motion','economy']){const key=k==='motion'?'chMotion':'chEconomy';if(s[k]===undefined)delete h.dataset[key];else h.dataset[key]=s[k];}if(s.lift)h.style.setProperty('--ch-motion-hover-lift',s.lift);else h.style.removeProperty('--ch-motion-hover-lift');})()`);
  }
}
module.exports = { verifyCatalogueHover };
