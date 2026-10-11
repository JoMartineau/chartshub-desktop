'use strict';
// Runs only from the native CI harness, against its real isolated renderers.
const assert = require('node:assert/strict');

async function verifyButtonMotion(contents, selector) {
  const evaluate = source => contents.executeJavaScript(source);
  const encoded = JSON.stringify(selector);
  const saved = await evaluate(`(()=>{const b=document.querySelector(${encoded}),h=document.documentElement;if(!b||b.disabled)throw Error('Enabled button required');return {motion:h.getAttribute('data-ch-motion'),economy:h.getAttribute('data-ch-economy'),disabled:b.disabled,aria:b.getAttribute('aria-disabled'),lift:h.style.getPropertyValue('--ch-motion-hover-lift')};})()`);
  assert.equal(contents.debugger.isAttached(), false, 'motion check owns its isolated debugger');
  contents.debugger.attach('1.3');
  const cdp = (method, params = {}) => contents.debugger.sendCommand(method, params);
  let nodeId;
  const observed = [];
  try {
    await cdp('DOM.enable'); await cdp('CSS.enable');
    const { root } = await cdp('DOM.getDocument');
    ({ nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector }));
    assert.ok(nodeId);
    const media = async features => { const values = new Map([['prefers-reduced-motion', 'no-preference'], ['forced-colors', 'none']]); for (const { name, value } of features) values.set(name, value); return cdp('Emulation.setEmulatedMedia', { features: [...values].map(([name, value]) => ({ name, value })) }); };
    await media([]);
    assert.equal(await evaluate("matchMedia('(hover: hover) and (pointer: fine)').matches"), true, 'desktop pointer supports hover');
    async function check(label, { motion = 'standard', economy = 'off', disabled = false, aria = null, active = false, lift = -3, scale = 1, preference = null } = {}) {
      await evaluate(`(()=>{const h=document.documentElement,b=document.querySelector(${encoded});h.dataset.chMotion=${JSON.stringify(motion)};h.dataset.chEconomy=${JSON.stringify(economy)};b.disabled=${disabled};${preference === null ? "h.style.removeProperty('--ch-motion-hover-lift')" : `h.style.setProperty('--ch-motion-hover-lift',${JSON.stringify(preference + 'px')})`};${aria === null ? "b.removeAttribute('aria-disabled')" : `b.setAttribute('aria-disabled',${JSON.stringify(aria)})`};})()`);
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: active ? ['hover', 'active'] : ['hover'] });
      const value = await evaluate(`(()=>{const b=document.querySelector(${encoded});getComputedStyle(b).translate;for(const a of b.getAnimations())if(['translate','scale'].includes(a.transitionProperty))a.finish();const s=getComputedStyle(b);return {translate:s.translate,scale:s.scale};})()`);
      const actualLift = value.translate === 'none' ? 0 : Number.parseFloat(value.translate.trim().split(/\s+/).at(-1));
      const actualScale = value.scale === 'none' ? 1 : Number.parseFloat(value.scale);
      assert.equal(actualLift, lift, label + ': ' + JSON.stringify(value));
      assert.equal(actualScale, scale, label + ': ' + JSON.stringify(value));
      observed.push(label);
    }
    await check('standard hover');
    await check('arcade hover', { motion: 'arcade', lift: -5 });
    for (const preference of [1, 3, 5]) await check('chosen hover ' + preference, { motion: 'arcade', preference, lift: -preference });
    await check('pressed', { active: true, lift: 1, scale: .985 });
    await check('disabled during hover', { disabled: true, lift: 0 });
    await check('aria-disabled', { aria: 'true', lift: 0 });
    await check('motion off', { motion: 'off', active: true, lift: 0 });
    await check('subtle', { motion: 'subtle', lift: 0 });
    await check('economy', { economy: 'on', active: true, lift: 0, preference: 5 });
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await check('reduced motion beats arcade', { motion: 'arcade', active: true, lift: 0, preference: 5 });
    await media([{ name: 'forced-colors', value: 'active' }]);
    await check('forced colors', { motion: 'arcade', lift: 0, preference: 5 });
  } finally {
    if (nodeId) await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await cdp('Emulation.setEmulatedMedia', { features: [] });
    await evaluate(`(()=>{const h=document.documentElement,b=document.querySelector(${encoded}),s=${JSON.stringify(saved)};for(const [key,value] of [['data-ch-motion',s.motion],['data-ch-economy',s.economy]]){if(value===null)h.removeAttribute(key);else h.setAttribute(key,value);}b.disabled=s.disabled;if(s.lift)h.style.setProperty('--ch-motion-hover-lift',s.lift);else h.style.removeProperty('--ch-motion-hover-lift');if(s.aria===null)b.removeAttribute('aria-disabled');else b.setAttribute('aria-disabled',s.aria);})()`);
    contents.debugger.detach();
  }
  return observed;
}
module.exports = { verifyButtonMotion };
