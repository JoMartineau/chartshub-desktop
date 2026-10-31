'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../companion/preload.cjs'), 'utf8');

function preload({ args = [], page = 'index.html', mainFrame = true } = {}) {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = { invoke() {}, on() {}, removeListener() {} };
  vm.runInNewContext(source, {
    require(name) { assert.equal(name, 'electron'); return { contextBridge, ipcRenderer }; },
    process: { argv: args, isMainFrame: mainFrame },
    location: { protocol: 'chartshub-companion:', hostname: 'app', href: 'chartshub-companion://app/ui/' + page },
  });
  return exposed.ChartsHubCompanion;
}

test('The public Companion keeps telemetry but exposes no calibration experiment by default', () => {
  for (const args of [[], ['--chartshub-calibration-beta=false'], ['--chartshub-calibration-beta=true'], ['--chartshub-companion-language=fr']]) {
    const api = preload({ args });
    assert.equal(api.features.gameplayMeasurements, false);
    assert.equal(api.features.calibrationBeta, false);
    assert.equal(Object.isFrozen(api.features), true);
    assert.equal(typeof api.command, 'function');
    assert.equal(typeof api.subscribe, 'function');
    assert.equal(typeof api.getSnapshot, 'function');
  }
});

test('Only an explicit trusted panel bootstrap enables the private calibration experiment', () => {
  assert.equal(preload({ args: ['--chartshub-calibration-beta'] }).features.calibrationBeta, false);
  const args = ['--chartshub-calibration-beta', '--chartshub-gameplay-measurements'];
  assert.equal(preload({ args }).features.gameplayMeasurements, true);
  assert.equal(preload({ args }).features.calibrationBeta, true);
  for (const page of ['overlay.html', 'stream.html', 'music-player.html', 'index.html?calibrationBeta=true']) {
    assert.equal(preload({ args, page }).features, undefined);
  }
  assert.equal(preload({ args, mainFrame: false }).features, undefined);
});
