'use strict';
const { shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(40);
  }
  throw Error('Timed out: ' + label);
}

/** Synthetic public-catalogue transport for the native verification harness only. */
function createCatalogueFixture() {
  const state = { loads: 0, artworks: 0, demo: false, failNext: false };
  const records = Array.from({ length: 26 }, (_, index) => {
    const id = 'native-catalogue-' + String(index).padStart(3, '0');
    return {
      id, title: index < 2 ? 'Library Chart 000' : 'Catalogue Chart ' + String(index).padStart(3, '0'),
      artist: index < 2 ? 'Artist 000' : 'Catalogue Artist', charter: index === 0 ? 'Creator 000' : 'Alternate Creator',
      verified: index === 0 ? true : index === 1 ? null : false,
      album: 'Native verification', year: '2024', genre: 'Rock', instruments: ['Guitar'], difficulties: ['Expert'],
      instrumentDifficulties: { Guitar: ['Expert'] }, contentHash: null,
      artworkUrl: index === 0 ? 'https://chartshub.ca/verification-cover.png' : null,
      downloadEndpoint: index < 2 ? '/api/charts/11111111-1111-4111-8111-11111111111' + index + '/native_token_000000000' + index + '/download-manifest' : null,
      viewUrl: 'https://chartshub.ca/index.html?chart=' + id + '&share=2',
    };
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  return {
    state,
    client: {
      load: async () => {
        state.loads++;
        await delay(30);
        if (state.failNext) { state.failNext = false; throw Error('Synthetic catalogue failure'); }
        return { items: structuredClone(records), demo: state.demo, warning: null, revision: 'native-verification' };
      },
      artwork: async url => {
        assert.equal(url, records[0].artworkUrl); state.artworks++;
        return { bytes: Buffer.from(png), contentType: 'image/png' };
      },
    },
  };
}

/** Exercises UI/IPC/rendering with no remote request and no external browser launch. */
async function verifyCatalogue(panel, host, data, passed, fixture) {
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const originalOpenExternal = shell.openExternal;
  const originalGame = structuredClone(host.snapshot().state);
  const originalEditorRevision = host.snapshot().editor.revision;
  let opened = null;
  const first = '[data-catalogue-id="native-catalogue-000"]';
  const second = '[data-catalogue-id="native-catalogue-001"]';
  const click = async selector => {
    await waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled&&!node.hidden})()`), 'catalogue control enabled: ' + selector);
    const point = await evaluate(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});
      const rect=node.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(!rect.width||!rect.height||!hit||!(hit===node||node.contains(hit)))throw Error('Catalogue target is hidden or covered.');
      return point;
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await delay(40);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(40);
  };
  const text = async (selector, value) => {
    await click(selector); await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
    await panel.webContents.insertText(value);
  };
  const rows = async expected => waitFor(() => evaluate(`document.querySelector('#catalogue-results').getAttribute('aria-busy')==='false'&&document.querySelectorAll('#catalogue-items [data-catalogue-id]').length===${expected}`), 'catalogue results: ' + expected);
  const readyToLink = () => evaluate(`document.querySelector('#catalogue-stale').hidden&&!!document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="link"]')})&&!document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="link"]')}).disabled`);
  const select = async (selector, value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);

  try {
    shell.openExternal = async url => { opened = url; };
    panel.setSize(1250, 900);
    assert.equal(fixture.state.loads, 0, 'opening the Companion and scanning the library never loads the public catalogue');
    assert.equal(host.snapshot().catalogue.status, 'idle');
    assert.equal(await evaluate("document.querySelectorAll('#catalogue-items [data-catalogue-id]').length"), 0);

    await click('#catalogue-search'); await rows(20);
    assert.equal(fixture.state.loads, 1);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(first + ' [data-catalogue-verified="true"]')})`), true);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(second + ' [data-catalogue-verified="true"]')})`), false);
    await evaluate(`document.querySelector(${JSON.stringify(first)}).scrollIntoView({block:'center'})`);
    await waitFor(() => evaluate(`(()=>{const image=document.querySelector(${JSON.stringify(first + ' img')});return !!image&&image.complete&&image.naturalWidth>0})()`), 'catalogue artwork renders through the local protocol');
    assert.ok(fixture.state.artworks > 0);
    await click('#catalogue-next'); await rows(6);
    await click('#catalogue-prev'); await rows(20);
    passed.push('catalogue stays offline until explicit search; paging, local artwork and true-only verified badges render');

    await text('#catalogue-query', 'Artist 000'); await click('#catalogue-search'); await rows(2);
    await select('#catalogue-verified', 'yes'); await click('#catalogue-search'); await rows(1);
    await select('#catalogue-verified', 'all');
    await select('#catalogue-instrument', 'Guitar'); await select('#catalogue-difficulty', 'Expert');
    await click('#catalogue-search'); await rows(2);
    await click(first + ' [data-catalogue-action="open"]');
    await waitFor(() => opened !== null, 'catalogue browser action');
    assert.equal(opened, 'https://chartshub.ca/index.html?chart=native-catalogue-000&share=2');
    assert.equal(fixture.state.loads, 1, 'search filters use the loaded public catalogue');
    passed.push('catalogue text, verification and instrument/difficulty filters use cached results; external opening is scoped in the harness');

    await text('#library-search', 'Library Chart 000'); await key('Enter');
    await waitFor(() => evaluate("document.querySelector('#library-results').getAttribute('aria-busy')==='false'&&document.querySelectorAll('#library-rows tr').length===1"), 'local chart row');
    await click('#library-rows button[data-library-catalogue-id]'); await rows(2);
    await waitFor(readyToLink, 'fresh local catalogue context');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(first + ' [data-catalogue-relation]')}).dataset.catalogueRelation`), 'candidate');
    await click(first + ' [data-catalogue-action="link"]');
    await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="unlink"]')})&&!document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="unlink"]')}).disabled`), 'explicit association recorded');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(first + ' [data-catalogue-relation]')}).textContent`), 'Liée à votre bibliothèque');
    const matchingFile = path.join(data, 'settings', 'matching.json');
    const linked = JSON.parse(await fs.readFile(matchingFile, 'utf8'));
    assert.equal(linked.links.length, 1); assert.equal(linked.links[0].chartId, 'native-catalogue-000');
    await evaluate("document.querySelector('#catalogue-local-context').scrollIntoView({block:'start'})");
    await fs.writeFile(path.join(data, 'companion-catalogue-linked.png'), (await panel.webContents.capturePage()).toPNG());
    await click(first + ' [data-catalogue-action="unlink"]'); await waitFor(readyToLink, 'association removed');
    assert.equal(JSON.parse(await fs.readFile(matchingFile, 'utf8')).links.length, 0);
    passed.push('local Sur ChartsHub shows alternatives; explicit link/unlink persist without treating metadata suggestions as installed charts');

    const previousLibraryRevision = host.snapshot().library.revision;
    await click('#library-refresh');
    await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.revision > previousLibraryRevision, 'library refresh invalidates matching context');
    await waitFor(() => evaluate(`!document.querySelector('#catalogue-stale').hidden&&document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="link"]')}).disabled`), 'stale associations disabled');
    await click('#catalogue-reload-results'); await rows(2); await waitFor(readyToLink, 'context reloaded explicitly');
    fixture.state.failNext = true;
    await click('#catalogue-refresh');
    await waitFor(() => host.snapshot().catalogue.status === 'error', 'synthetic refresh failure');
    await waitFor(() => evaluate(`!document.querySelector('#catalogue-stale').hidden&&document.querySelector(${JSON.stringify(first + ' [data-catalogue-action="link"]')}).disabled&&!document.querySelector('#catalogue-refresh').disabled`), 'failed refresh keeps old matching context disabled');
    await click('#catalogue-refresh'); await rows(2); await waitFor(readyToLink, 'catalogue refresh recovery');
    passed.push('library changes and failed remote refresh invalidate association controls until an explicit reload succeeds');

    fixture.state.demo = true;
    await click('#catalogue-refresh'); await rows(2);
    await waitFor(() => evaluate("!document.querySelector('#catalogue-demo').hidden&&document.querySelectorAll('#catalogue-items [data-catalogue-verified]').length===0&&[...document.querySelectorAll('#catalogue-items [data-catalogue-action=link]')].every(button=>button.disabled)"), 'demonstration records clearly marked and cannot be associated');
    assert.equal(JSON.parse(await fs.readFile(matchingFile, 'utf8')).links.length, 0);
    fixture.state.demo = false;
    await click('#catalogue-refresh'); await rows(2); await waitFor(readyToLink, 'restore normal catalogue fixture');
    assert.deepEqual(host.snapshot().state, originalGame);
    assert.equal(host.snapshot().editor.revision, originalEditorRevision);
    panel.setSize(900, 660);
    await evaluate("document.querySelector('#catalogue-panel').scrollIntoView({block:'start'})");
    await delay(120);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await fs.writeFile(path.join(data, 'companion-catalogue.png'), (await panel.webContents.capturePage()).toPNG());
    passed.push('catalogue demo suppresses verified badges and associations; narrow layout fits without changing overlay/gameplay state');
  } finally {
    fixture.state.demo = false;
    fixture.state.failNext = false;
    shell.openExternal = originalOpenExternal;
  }
}

module.exports = { createCatalogueFixture, verifyCatalogue };
