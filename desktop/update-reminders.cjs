'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { plain } = require('./update-plan.cjs');
const { compareVersions, version } = require('./update-release.cjs');

const START_DELAY = 5000;
const CHECK_INTERVAL = 30 * 60 * 1000;
const RETRY_DELAY = 30000;

function updateReminderPreferences(directory) {
  const file = path.join(directory, 'update-reminder.json');
  async function read() {
    const info = await plain(file, { missing: true });
    if (!info) return null;
    if (info.size < 1 || info.size > 128) throw Error('Invalid update reminder preference');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw Error('Update reminder preference changed');
      const bytes = Buffer.alloc(129);
      const { bytesRead } = await handle.read(bytes);
      if (bytesRead !== info.size) throw Error('Invalid update reminder preference');
      const stored = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      version(stored.notifiedVersion);
      return stored.notifiedVersion;
    } finally { await handle.close(); }
  }
  async function write(releaseVersion) {
    version(releaseVersion);
    await plain(directory, { directory: true });
    const previous = await read();
    if (previous && compareVersions(releaseVersion, previous) <= 0) return;
    const temporary = path.join(directory, '.update-reminder-' + randomUUID() + '.tmp');
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify({ notifiedVersion: releaseVersion }) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await plain(file, { missing: true });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  return { read, write };
}

function createUpdateReminders({ updater, preferences, canPrompt, show, onAccept, onManualResult, schedule = setTimeout, cancel = clearTimeout }) {
  let disposed = false, busy = false, timer = null, notifiedVersion, pending = false;
  async function showAvailable(manual) {
    const state = updater.snapshot();
    if (!['available', 'ready'].includes(state.status)) { pending = false; return; }
    if (notifiedVersion === undefined) notifiedVersion = await preferences.read().catch(() => null);
    if (!manual && notifiedVersion && compareVersions(state.latestVersion, notifiedVersion) <= 0) { pending = false; return; }
    const current = updater.snapshot();
    if (disposed || !canPrompt() || current.status !== state.status || current.latestVersion !== state.latestVersion) return;
    const accepted = await show(state);
    pending = false;
    if (!notifiedVersion || compareVersions(state.latestVersion, notifiedVersion) > 0) {
      notifiedVersion = state.latestVersion;
      await preferences.write(notifiedVersion).catch(() => {});
    }
    const selected = updater.snapshot();
    if (accepted && !disposed && canPrompt() && selected.latestVersion === state.latestVersion && ['available', 'ready'].includes(selected.status)) {
      await onAccept(selected);
    }
  }
  async function check(manual = false) {
    if (disposed || busy || !canPrompt()) return false;
    if (!pending || manual) {
      if (!updater.snapshot().canCheck) return false;
    }
    busy = true;
    try {
      if (!pending || manual) {
        const state = await updater.check();
        pending = ['available', 'ready'].includes(state.status);
        if (!pending && manual && !disposed && canPrompt()) await onManualResult(false);
      }
      if (pending) await showAvailable(manual);
      return !pending;
    } catch {
      if (manual && !disposed && canPrompt()) await onManualResult(true).catch(() => {});
      return true;
    } finally { busy = false; }
  }
  function queue(delay) {
    if (disposed || timer !== null) return;
    timer = schedule(async () => {
      timer = null;
      const completed = await check();
      queue(completed ? CHECK_INTERVAL : RETRY_DELAY);
    }, delay);
    timer?.unref?.();
  }
  return {
    start() { queue(START_DELAY); },
    checkManually() { return check(true); },
    dispose() { disposed = true; if (timer !== null) cancel(timer); timer = null; }
  };
}

module.exports = { createUpdateReminders, updateReminderPreferences, START_DELAY, CHECK_INTERVAL, RETRY_DELAY };
