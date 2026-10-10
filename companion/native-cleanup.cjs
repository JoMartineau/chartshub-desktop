'use strict';
const path = require('node:path');
const { recheckBundleIdentity } = require('./chart-bundle.cjs');

const denied = () => Error('Copie modifiée ou nettoyage non autorisé.');
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/** The worker has rehashed both bundles. Check its private identity receipt
 * again in the main process, after the IPC hop and before the native recycle.
 * This never authorizes a path absent from the user's native confirmation. */
async function verifyNativeCleanup({ root, keep, target, proof } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof keep !== 'string' || !path.isAbsolute(keep)
    || typeof target !== 'string' || !path.isAbsolute(target) || !inside(root, keep) || !inside(root, target)
    || path.relative(keep, target) === '' || inside(keep, target) || inside(target, keep)
    || !proof || proof.rootPath !== root || !proof.keeper || !proof.target) throw denied();
  const kept = await recheckBundleIdentity({ ...proof.keeper, rootPath: root });
  const checked = await recheckBundleIdentity({ ...proof.target, rootPath: root });
  if (kept !== keep || checked !== target) throw denied();
}

module.exports = { verifyNativeCleanup };
