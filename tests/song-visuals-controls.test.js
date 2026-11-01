'use strict';
const test = require('node:test'), assert = require('node:assert/strict');

class Element extends EventTarget {
  constructor(tagName, ownerDocument) {
    super(); Object.assign(this, { tagName, ownerDocument, children: [], dataset: {}, textContent: '', hidden: false, disabled: false });
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this[name] = value; }
}
async function fixture() {
  const calls = [], document = { createElement: name => new Element(name, document) }, root = document.createElement('section');
  const { SongVisualControls } = await import('../companion/ui/song-visuals-controls.js');
  const controls = new SongVisualControls({ root, command: (...args) => { calls.push(args); return { ok: true }; } });
  return { controls, calls };
}
const snapshot = (language, gameWidgets = {}, visuals = {}) => ({
  language, features: { gameplayMeasurements: false, gameWidgets: true },
  gameWidgets: { lyrics: false, accuracy: false, connected: false, ...gameWidgets },
  visuals: { state: 'ready', hasLyrics: true, clockReady: false, ...visuals }, stream: { enabled: false }
});

test('French and English guidance locates explicit optional lyrics activation without starting anything', async () => {
  const { controls, calls } = await fixture();
  for (const language of ['fr', 'en']) {
    // A retained media snapshot cannot claim synchronization while lyrics are off.
    controls.update(snapshot(language, { accuracy: true, connected: true }, { clockReady: true }));
    const text = controls.lyricsStatus.textContent;
    assert.match(text, language === 'fr' ? /Catalogue → Intégrations Clone Hero/ : /Catalogue → Clone Hero integrations/);
    assert.match(text, language === 'fr' ? /module Widgets optionnel/ : /optional Widgets module/);
    assert.match(text, language === 'fr' ? /capture recadrée/ : /cropped game/);
    assert.doesNotMatch(text, /indisponible dans cette version|unavailable in this version|disponibles dans le widget|available in the Synchronized lyrics widget/);
  }
  assert.deepEqual(calls, []); controls.dispose();
});

test('enabled lyrics wait for a current provider connection even if media retained a ready clock', async () => {
  const { controls, calls } = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update(snapshot(language, { lyrics: true, connected: false }, { clockReady: true }));
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /en attente de la connexion/ : /waiting for the optional Widgets module to connect/);
    assert.doesNotMatch(controls.lyricsStatus.textContent, /disponibles dans le widget|available in the Synchronized lyrics widget/);
  }
  assert.deepEqual(calls, []); controls.dispose();
});

test('a connected optional provider preserves actual clock, missing lyric and ambiguity status in both languages', async () => {
  const { controls } = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update(snapshot(language, { lyrics: true, connected: true }));
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /en attente de l’horloge/ : /waiting for the game clock/);
    controls.update(snapshot(language, { lyrics: true, connected: true }, { clockReady: true }));
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /disponibles dans le widget Paroles synchronisées/ : /available in the Synchronized lyrics widget/);
    for (const reason of ['missing', 'ambiguous']) {
      controls.update(snapshot(language, { lyrics: true, connected: true }, { hasLyrics: false, clockReady: true, lyricsReason: reason }));
      assert.match(controls.lyricsStatus.textContent, reason === 'missing' ? language === 'fr' ? /ne contient pas de paroles/ : /contains no lyrics/ : language === 'fr' ? /ambiguës/ : /ambiguous/);
      assert.doesNotMatch(controls.lyricsStatus.textContent, /disponibles dans le widget|available in the Synchronized lyrics widget/);
    }
    controls.update(snapshot(language, { lyrics: true, connected: true }, { state: 'waiting', hasLyrics: false, clockReady: false }));
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /en attente du morceau local/ : /waiting for the local song/);
  }
  controls.dispose();
});

test('legacy private timing remains accurate and absent optional support never promises local synchronization', async () => {
  const { controls, calls } = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update({ ...snapshot(language, {}, { clockReady: true }), features: { gameplayMeasurements: true, gameWidgets: false } });
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /disponibles dans le widget/ : /available in the Synchronized lyrics widget/);
    controls.update({ ...snapshot(language, {}, { clockReady: true }), features: { gameplayMeasurements: false, gameWidgets: false } });
    assert.match(controls.lyricsStatus.textContent, language === 'fr' ? /nécessite le module Widgets optionnel compatible/ : /requires the compatible optional Widgets module/);
    assert.doesNotMatch(controls.lyricsStatus.textContent, /disponibles dans le widget|available in the Synchronized lyrics widget/);
  }
  assert.deepEqual(calls, []); controls.dispose();
});
