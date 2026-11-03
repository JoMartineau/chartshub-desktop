'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUpdateReminders, updateReminderPreferences, START_DELAY, CHECK_INTERVAL, RETRY_DELAY } = require('../desktop/update-reminders.cjs');

function fixture(preferences) {
  let latestVersion = '0.14.42', available = true, accept = false, checks = 0;
  let state = { status: 'idle', canCheck: true };
  const prompts = [], accepted = [], timers = new Map();
  const reminders = createUpdateReminders({
    updater: {
      snapshot: () => state,
      async check() { checks++; state = { status: 'available', latestVersion, canCheck: true }; return state; }
    },
    preferences,
    canPrompt: () => available,
    show: async value => { prompts.push(value.latestVersion); return accept; },
    onAccept: async value => { accepted.push(value.latestVersion); },
    onManualResult: async () => assert.fail('The fixture always has a new release'),
    schedule(callback, delay) { const token = {}; timers.set(token, { callback, delay }); return token; },
    cancel: token => timers.delete(token)
  });
  return {
    reminders, prompts, accepted, timers,
    setLatest(value) { latestVersion = value; },
    setAvailable(value) { available = value; },
    setAccept(value) { accept = value; },
    checks: () => checks,
    async tick(expectedDelay) {
      assert.equal(timers.size, 1);
      const [[token, timer]] = timers;
      assert.equal(timer.delay, expectedDelay);
      timers.delete(token);
      await timer.callback();
    }
  };
}

test('startup and periodic checks remember a shown release across restart, and Later leaves manual access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-reminder-test-'));
  t.after(async () => {
    await fs.unlink(path.join(directory, 'update-reminder.json')).catch(() => {});
    await fs.rmdir(directory);
  });
  const first = fixture(updateReminderPreferences(directory));
  first.reminders.start();
  await first.tick(START_DELAY);
  assert.deepEqual(first.prompts, ['0.14.42']);
  assert.deepEqual(first.accepted, []);
  await first.tick(CHECK_INTERVAL);
  assert.equal(first.checks(), 2);
  assert.equal(first.prompts.length, 1);
  first.reminders.dispose();
  assert.equal(first.timers.size, 0);

  const second = fixture(updateReminderPreferences(directory));
  second.reminders.start();
  await second.tick(START_DELAY);
  assert.deepEqual(second.prompts, []);
  second.setAccept(true);
  await second.reminders.checkManually();
  assert.deepEqual(second.accepted, ['0.14.42']);
  second.setLatest('0.14.43');
  second.setAccept(false);
  await second.tick(CHECK_INTERVAL);
  assert.deepEqual(second.prompts, ['0.14.42', '0.14.43']);
  assert.equal(await updateReminderPreferences(directory).read(), '0.14.43');
  second.reminders.dispose();
});

test('a temporarily unavailable window delays the check and cannot display a late prompt after disposal', async () => {
  const f = fixture({ read: async () => null, write: async () => {} });
  f.setAvailable(false);
  f.reminders.start();
  await f.tick(START_DELAY);
  assert.equal(f.checks(), 0);
  f.setAvailable(true);
  await f.tick(RETRY_DELAY);
  assert.deepEqual(f.prompts, ['0.14.42']);
  const [{ callback }] = f.timers.values();
  f.reminders.dispose();
  await callback();
  assert.equal(f.checks(), 1);
  assert.equal(f.timers.size, 0);
});
