'use strict';
const path = require('node:path');

// Downloads already validate their destination. This only schedules an index
// refresh when a newly completed download belongs to the chosen Songs root.
function createLibraryDownloadRefresh({ context, scan, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 750 }) {
  let states = null, pending = null, timer = null;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const within = (root, destination) => {
    if (typeof root !== 'string' || typeof destination !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(destination)) return false;
    const relative = path.relative(root, destination);
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  function update() {
    const current = context();
    if (!pending || !current.active || current.root !== pending.root || current.lifecycle !== pending.lifecycle) { clear(); pending = null; return; }
    if (current.scanning && !pending.wasScanning) pending.scanRevision = current.revision;
    if (pending.wasScanning && !current.scanning && (!current.ready || !Number.isSafeInteger(pending.scanRevision) || current.revision <= pending.scanRevision)) {
      // Cancelled scans do not cover this download. A later cleanup may advance
      // the index revision too, so it must not be mistaken for that scan commit.
      pending.scanRevision = null;
    }
    pending.wasScanning = current.scanning === true;
    // Folder detection may already have started the required scan. Absorb that
    // work only when it started after this download and committed successfully.
    if (current.ready && Number.isSafeInteger(pending.scanRevision) && current.revision > pending.scanRevision) {
      clear(); pending = null; return;
    }
    if (!current.ready || current.busy) { clear(); return; }
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      const latest = context();
      if (!pending || !latest.active || latest.root !== pending.root || latest.lifecycle !== pending.lifecycle) { pending = null; return; }
      if (!latest.ready || latest.busy) return;
      pending = null;
      // A filesystem failure does not spin a scan loop or alter the old index.
      void Promise.resolve().then(scan).catch(() => {});
    }, delayMs);
    timer?.unref?.();
  }
  function observe(value) {
    const items = Array.isArray(value?.items) ? value.items : [], current = context();
    const changed = states && items.some(item => item.state === 'Completed' && states.get(item.id) !== 'Completed' && within(current.root, item.destination));
    states = new Map(items.map(item => [item.id, item.state]));
    if (changed && current.active) {
      clear(); pending = { root: current.root, lifecycle: current.lifecycle, wasScanning: current.scanning === true, scanRevision: null };
    }
    update();
  }
  function stop() { clear(); pending = null; }
  return { observe, update, stop };
}
module.exports = { createLibraryDownloadRefresh };
