'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readableAccent } = require('../desktop/palette-contrast.js');
const rgb = value => value.slice(1).match(/../g).map(v => parseInt(v, 16));
const light = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const ratio = (a, b) => (Math.max(light(a), light(b)) + .05) / (Math.min(light(a), light(b)) + .05);
test('black, white and custom accents keep selected navigation and keyboard focus readable', () => {
  for (const nav of ['#111c2e', '#ffffff']) for (const accent of ['#000000', '#ffffff', '#ffb77c', '#00ff11', '#170025', '#ffff00', '#8768ff']) for (const secondary of ['#000000', '#ffffff', '#ff0000']) {
    const ink = readableAccent(accent, nav, secondary), background = rgb(nav);
    assert.match(ink, /^#[a-f\d]{6}$/);
    assert.ok(ratio(rgb(ink), background) >= 4.5, 'keyboard focus on navigation');
    const from = background.map((v, i) => v * .90 + rgb(accent)[i] * .10), to = background.map((v, i) => v * .92 + rgb(secondary)[i] * .08);
    for (let point = 0; point <= 100; point++) assert.ok(ratio(rgb(ink), from.map((v, i) => v * (1 - point / 100) + to[i] * point / 100)) >= 4.5, `${accent} on ${nav}: ${ink}`);
  }
});
test('readable hues remain exact; adjusting ink never alters the decorative accent', () => {
  assert.equal(readableAccent('#FFB77C', '#111c2e', '#bfa4ff'), '#ffb77c');
  assert.equal(readableAccent('#000000', '#111c2e', '#ffffff').startsWith('#'), true);
  for (const bad of [null, 'url(x)', '#fff', '#000000;opacity:0']) assert.equal(readableAccent(bad, '#111c2e', '#ffffff'), '#ffffff');
});
