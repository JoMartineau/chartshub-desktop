'use strict';
const fs = require('node:fs'), path = require('node:path');
const CODES = 'fr|en|es-MX|zh-Hans|ja|pt-BR|hi|ar|bn|ru|ur|id';
const MATCH = new RegExp('^/assets/(?:locale-runtime\\.js|locale-layout\\.css|locale\\.(?:' + CODES + ')\\.json)$');
const isLocaleAsset = pathname => typeof pathname === 'string' && MATCH.test(pathname);
function localeAssetPath(productRoot, pathname) {
  if (!isLocaleAsset(pathname)) return null;
  try {
    const root = fs.realpathSync(productRoot), base = fs.realpathSync(path.join(root, 'assets'));
    if (!base.startsWith(root + path.sep)) return null;
    const candidate = path.join(base, path.basename(pathname));
    const info = fs.lstatSync(candidate), actual = fs.realpathSync(candidate);
    return info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024 && path.dirname(actual) === base ? actual : null;
  } catch { return null; }
}
const contentType = filename => filename.endsWith('.json') ? 'application/json; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
module.exports = { isLocaleAsset, localeAssetPath, contentType };
