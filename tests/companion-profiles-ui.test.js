const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { setMaxListeners } = require('node:events');
const { test } = require('node:test');

class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.dataset = {}; this.attributes = {};
    this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.text = '';
    this.classList = { toggle: (name, enabled) => { this.ownerDocument.writes++; this.attributes[name] = enabled; } };
  }
  set textContent(value) { this.ownerDocument.writes++; this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('Metadata must never be interpreted as HTML'); }
  addEventListener(type, listener, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, listener, options); }
  append(...children) { this.ownerDocument.writes++; for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { this.ownerDocument.writes++; this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.ownerDocument.writes++; this.attributes[name] = String(value); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('#') ? element.id === selector.slice(1) : selector.split(',').some(tag => tag.trim() === element.tagName);
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture() {
  const document = { activeElement: null, writes: 0, createElement(tag) { return new Element(this, tag); } };
  const root = document.createElement('main');
  const panel = document.createElement('section'); panel.id = 'profiles-panel'; root.append(panel);
  const html = readFileSync(require.resolve('../companion/ui/index.html'), 'utf8').split('<section id="profiles-panel"')[1].split('</section>')[0];
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) { const element = document.createElement(tag); element.id = id; panel.append(element); }
  const get = selector => root.querySelector(selector);
  const data = (key, value) => panel.querySelectorAll('button').find(button => button.dataset[key] === value);
  return { document, root, get, data };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const profile = (id, name) => ({ id, name, updatedAt: '2026-10-04T12:30:00.000Z' });
const first = profile('11111111-1111-4111-8111-111111111111', 'Stream');
const second = profile('22222222-2222-4222-8222-222222222222', '<img src=x onerror=neverExecute()>');
const snapshot = (items = [first, second], extra = {}) => ({ editor: { revision: 7 }, profiles: { revision: 2, items, activeId: first.id, error: null, canWrite: true, ...extra } });

test('profile controls preserve a rename draft across snapshots and apply saved profiles in one click', async () => {
  const { ProfileControls } = await import('../companion/dist/settings/ProfileControls.js');
  const ui = fixture(), calls = [], pending = [];
  const controls = new ProfileControls({ root: ui.root, command: (name, payload) => { calls.push({ name, payload }); return new Promise(resolve => pending.push(resolve)); } });
  controls.update(snapshot());
  const apply = ui.data('profileApply', second.id);
  assert.match(apply.textContent, /<img src=x onerror=neverExecute\(\)>/);
  ui.data('profileSelect', second.id).click();
  assert.equal(calls.length, 0, 'managing a profile does not apply it');
  const input = ui.get('#profiles-name');
  input.value = 'Concert'; input.dispatchEvent(new Event('input'));
  const latest = snapshot(undefined, { activeId: null, revision: 3 }); latest.editor.revision = 11;
  controls.update(latest);
  assert.equal(input.value, 'Concert'); assert.equal(ui.document.activeElement, input);
  assert.equal(ui.data('profileApply', second.id), apply, 'gameplay snapshots preserve rows');
  assert.match(ui.get('#profiles-current-status').textContent, /modifiée/);
  ui.get('#profiles-update').click(); ui.get('#profiles-update').click();
  assert.deepEqual(calls, [{ name: 'profile.save', payload: { revision: 11, profilesRevision: 3, name: 'Concert', id: second.id } }]);
  assert.equal(ui.get('#profiles-name').disabled, true); assert.equal(apply.disabled, true);
  const saved = snapshot([first, { ...second, name: 'Concert' }], { revision: 4, activeId: second.id }); saved.editor.revision = 11;
  controls.update(saved); pending.shift()({ ok: true }); await tick();
  assert.equal(input.value, 'Concert'); assert.equal(input.disabled, false);
  ui.data('profileApply', first.id).click();
  assert.deepEqual(calls[1], { name: 'profile.apply', payload: { revision: 11, profilesRevision: 4, id: first.id } });
  pending.shift()({ ok: false, error: 'La disposition a changé. Réessayez.' }); await tick();
  assert.equal(ui.get('#profiles-feedback').attributes.role, 'alert');
  assert.match(ui.get('#profiles-feedback').textContent, /Réessayez/);
  input.value = 'Copie du concert'; input.dispatchEvent(new Event('input')); ui.get('#profiles-create').click();
  assert.equal(calls[2].name, 'profile.save'); assert.equal(calls[2].payload.id, undefined);
  const created = profile('33333333-3333-4333-8333-333333333333', 'Copie du concert');
  controls.update(snapshot([first, second, created], { revision: 5, activeId: first.id }));
  pending.shift()({ ok: true }); await tick();
  assert.equal(ui.data('profileSelect', created.id).attributes['aria-pressed'], 'true', 'new profile stays selected even if equivalent content makes another profile active');
  assert.equal(input.value, created.name);
  controls.dispose();
});

test('profile deletion needs inline confirmation; limits, read-only state and disposal prevent writes', async () => {
  const { ProfileControls } = await import('../companion/dist/settings/ProfileControls.js');
  const ui = fixture(), calls = [], pending = [];
  const controls = new ProfileControls({ root: ui.root, command: (name, payload) => { calls.push({ name, payload }); return new Promise(resolve => pending.push(resolve)); } });
  controls.update(snapshot()); ui.data('profileSelect', second.id).click();
  ui.get('#profiles-delete').click();
  assert.equal(calls.length, 0); assert.equal(ui.get('#profiles-delete-prompt').hidden, false);
  ui.get('#profiles-delete-cancel').click();
  assert.equal(calls.length, 0); assert.equal(ui.get('#profiles-delete-prompt').hidden, true);
  ui.get('#profiles-delete').click(); ui.get('#profiles-delete-confirm').click();
  assert.deepEqual(calls[0], { name: 'profile.delete', payload: { profilesRevision: 2, id: second.id } });
  controls.update(snapshot([first], { revision: 3 })); pending.shift()({ ok: true }); await tick();
  assert.equal(ui.data('profileApply', second.id), undefined);
  assert.equal(ui.get('#profiles-delete-prompt').hidden, true);
  const twenty = Array.from({ length: 20 }, (_, index) => profile(`item-${index}`, `Profil ${index}`));
  controls.update(snapshot(twenty, { activeId: null }));
  assert.equal(ui.get('#profiles-create').disabled, true); assert.equal(ui.get('#profiles-limit').hidden, false);
  controls.update(snapshot([first], { canWrite: false, error: 'Enregistrement indisponible.' }));
  assert.equal(ui.get('#profiles-create').disabled, true); assert.equal(ui.get('#profiles-delete').disabled, true);
  assert.equal(ui.get('#profiles-error').hidden, false); assert.equal(ui.data('profileApply', first.id).disabled, true);
  ui.data('profileApply', first.id).click(); assert.equal(calls.length, 1);
  controls.update(snapshot([first]));
  ui.data('profileApply', first.id).click();
  controls.dispose(); const writes = ui.document.writes;
  pending.shift()({ ok: true }); await tick(); controls.update(snapshot());
  ui.get('#profiles-create').click();
  assert.equal(ui.document.writes, writes, 'late responses and snapshots do not touch disposed UI');
  assert.equal(calls.length, 2);
});
