'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectChartBundle } = require('../companion/chart-bundle.cjs');
const { verifyNativeCleanup } = require('../companion/native-cleanup.cjs');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-native-cleanup-'));
  const root = path.join(base, 'Songs'), keep = path.join(root, 'Keep'), target = path.join(root, 'Copy');
  for (const folder of [keep, target]) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}');
    await fs.writeFile(path.join(folder, 'song.ogg'), 'same-audio');
  }
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('chartshub-native-cleanup-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const item = async relativePath => ({ relativePath, format: 'chart', expected: await inspectChartBundle({ rootPath: root, relativePath, format: 'chart' }) });
  const proof = { rootPath: root, keeper: await item('Keep/notes.chart'), target: await item('Copy/notes.chart') };
  assert.equal(proof.keeper.expected.status, 'verified');
  assert.equal(proof.target.expected.status, 'verified');
  return { base, root, keep, target, proof };
}

test('native boundary accepts only the verified, confirmed keeper and target identities', async t => {
  const f = await fixture(t);
  await verifyNativeCleanup(f);
  for (const change of [
    { proof: undefined }, { target: f.keep }, { target: f.root }, { target: f.base },
    { target: path.join(f.base, 'outside') }, { keep: f.target },
    { proof: { ...f.proof, rootPath: f.base } },
    { proof: { ...f.proof, target: { ...f.proof.target, relativePath: '../outside/notes.chart' } } },
    { proof: { ...f.proof, target: f.proof.keeper } }
  ]) await assert.rejects(verifyNativeCleanup({ ...f, ...change }), /modifiée|autorisé/);
});

test('native boundary rejects edits in keeper or copy after the worker finished hashing', async t => {
  for (const member of ['keep', 'target']) {
    const f = await fixture(t), filename = path.join(f[member], 'song.ogg'), before = await fs.stat(filename);
    await fs.writeFile(filename, 'edit-audio');
    await fs.utimes(filename, before.atime, before.mtime);
    await assert.rejects(verifyNativeCleanup(f), /modifiée/);
  }
});

test('native boundary rejects a target replaced by a byte-identical directory', async t => {
  const f = await fixture(t), moved = path.join(f.base, 'original-copy');
  await fs.rename(f.target, moved);
  await fs.cp(moved, f.target, { recursive: true, preserveTimestamps: true });
  await assert.rejects(verifyNativeCleanup(f), /modifiée/);
});

test('native boundary rejects added files after worker validation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.target, 'unconfirmed.txt'), 'must survive');
  await assert.rejects(verifyNativeCleanup(f), /modifiée/);
  assert.equal(await fs.readFile(path.join(f.target, 'unconfirmed.txt'), 'utf8'), 'must survive');
});

test('native boundary rejects a junction replacing the copy without modifying its outside target', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside');
  await fs.rename(f.target, outside);
  await fs.symlink(outside, f.target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyNativeCleanup(f), /modifiée/);
  assert.equal(await fs.readFile(path.join(outside, 'song.ogg'), 'utf8'), 'same-audio');
});
