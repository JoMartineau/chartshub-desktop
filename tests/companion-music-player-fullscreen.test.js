'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedPlayerFullscreen } = require('../companion/security.cjs');
const contents = page => ({ mainFrame: { url: 'chartshub-companion://app/ui/' + page }, isDestroyed: () => false });

test('only live exact main player surfaces may request ordinary fullscreen', () => {
  const panel = contents('index.html'), player = contents('music-player.html');
  const targets = { active: true, panelContents: panel, playerContents: player };
  for (const web of [panel, player]) {
    const details = { isMainFrame: true, requestingUrl: web.mainFrame.url };
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, targets), true);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, targets, 'chartshub-companion://app'), true);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, targets, 'chartshub-companion://app/'), true);
    for (const permission of ['automatic-fullscreen', 'media', 'clipboard-read', 'display-capture', 'unknown']) assert.equal(trustedPlayerFullscreen(web, permission, details, targets), false);
    for (const origin of ['null', 'https://chartshub.ca', 'chartshub-companion://other', 'chartshub-companion://app.evil', 'chartshub-companion://app/ui/index.html']) assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, targets, origin), false);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', { ...details, isMainFrame: false }, targets), false);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', { isMainFrame: true }, targets), false);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', { ...details, requestingUrl: details.requestingUrl + '?request=video' }, targets), false);
    assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, { ...targets, active: false }), false);
  }
});

test('closed, replaced and unrelated windows cannot reuse player fullscreen permission', () => {
  const player = contents('music-player.html'), panel = contents('index.html');
  const targets = { active: true, panelContents: panel, playerContents: player }, details = { isMainFrame: true, requestingUrl: player.mainFrame.url };
  for (const web of [null, contents('music-player.html'), contents('catalogue-widget.html'), contents('filters-widget.html'), contents('overlay.html')]) assert.equal(trustedPlayerFullscreen(web, 'fullscreen', details, targets), false);
  player.isDestroyed = () => true;
  assert.equal(trustedPlayerFullscreen(player, 'fullscreen', details, targets), false);
  player.isDestroyed = () => false; player.mainFrame.url += '#video';
  assert.equal(trustedPlayerFullscreen(player, 'fullscreen', details, targets), false);
});
