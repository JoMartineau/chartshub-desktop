const { setMaxListeners } = require('node:events');
class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ''; this.text = '';
    const values = new Map(); this.style = { setProperty: (name, value) => { document.writes++; values.set(name, value); }, getPropertyValue: name => values.get(name) ?? '' };
    this.classList = { toggle: (name, value) => { document.writes++; this.attributes[name] = value; } };
  }
  set textContent(value) { this.ownerDocument.writes++; this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('Untrusted metadata must never become HTML'); }
  append(...children) { this.ownerDocument.writes++; this.children.push(...children); }
  setAttribute(name, value) { this.ownerDocument.writes++; this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, listener, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, listener, options); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('#') ? element.id === selector.slice(1) : selector.startsWith('.') ? element.className?.split(' ').includes(selector.slice(1)) : element.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.ownerDocument.activeElement = this; }
}
function createDocument() {
  const document = { writes: 0, documentElement: { lang: 'fr' }, defaultView: new EventTarget(), createElement(tag) { return new Element(this, tag); } };
  return document;
}
module.exports = { createDocument, Element, tick: () => new Promise(resolve => setImmediate(resolve)) };
