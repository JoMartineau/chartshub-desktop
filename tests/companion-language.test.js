'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
test('catalogue preload forwards only the active FR/EN language to the trusted main process',()=>{
 const preload=read('preload.js'),main=read('main.js'),host=read('companion/host.cjs');
 assert.match(preload,/chartshub:languagechange/);assert.match(preload,/ipcRenderer\.invoke\('chartshub:language',value\)/);
 assert.match(main,/!\['fr','en'\]\.includes\(value\)/);assert.match(main,/host=>host\.setLanguage\(value\)/);
 assert.match(host,/function setLanguage\(value\)/);assert.match(host,/snapshot = \(\) => \(\{ language,/);
});
test('Companion localization loads before panel code and protects user-content selectors',()=>{
 const html=read('companion/ui/index.html'),locale=read('companion/ui/localization.js');
 assert.ok(html.indexOf('./localization.js')<html.indexOf('./panel.js'));
 for(const selector of ['.library-relative-path','.catalogue-item h3','.catalogue-item-artist','.download-item h3','.profile-item-name'])assert.ok(locale.includes(selector),selector);
 assert.match(locale,/initialLanguage/);assert.match(locale,/chartshub:languagechange/);
});
test('native Companion dialogs use the synchronized language helper',()=>{
 const host=read('companion/host.cjs');
 for(const phrase of ['Choose Clone Hero Songs folder','Choose ChartsHub download folder','Choose Clone Hero currentsong.txt','Send copies to Windows Recycle Bin','Delete this copy anyway?','Connect ReShade effects'])assert.ok(host.includes(phrase),phrase);
});

test('native Theme panel follows the synchronized document language',()=>{
 const bloom=read('companion/ui/ui-bloom.js');
 assert.match(bloom,/const fr = \(\) => document\.documentElement\.lang/);
 assert.match(bloom,/window\.addEventListener\('chartshub:languagechange', translate\)/);
 assert.ok(bloom.includes("button('open', 'Theme', 'Thème')"));
});

test('direct duplicate cleanup labels are available in both French and English',()=>{
 const source=read('companion/src/settings/DuplicateComparisonControls.ts'),locale=read('companion/ui/localization.js'),html=read('companion/ui/index.html');
 for(const phrase of ['Supprimer l’autre version','Supprimer les ','Supprimer quand même','Aucune autre version sûre à supprimer','Revérifier les autres versions'])assert.ok(source.includes(phrase),phrase);
 for(const phrase of ['Delete the other version','Delete the ','Delete anyway','No other safe version to delete','Recheck other versions','Delete this copy:','Delete this copy anyway:','Deletion blocked:'])assert.ok(locale.includes(phrase),phrase);
 assert.match(html,/copies sûres sont présélectionnées/);
});
