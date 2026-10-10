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
 for(const phrase of ['Envoyer la copie sélectionnée à la Corbeille…','copies sélectionnées à la Corbeille…','Supprimer quand même','Cochez les copies à envoyer à la Corbeille','Revérifier les autres versions'])assert.ok(source.includes(phrase),phrase);
 for(const phrase of ['Send the selected copy to the Recycle Bin…','Delete anyway','Select the copies to send to the Recycle Bin','Recheck other versions','Delete this copy:','Delete this copy anyway:','Deletion blocked:'])assert.ok(locale.includes(phrase),phrase);
 assert.match(html,/Cochez individuellement les copies à supprimer/);
 assert.match(html,/Les copies non cochées restent en place/);
 assert.doesNotMatch(html,/copies sûres sont présélectionnées/);
});

test('duplicate selection and protection summaries translate with actual counts in both languages',()=>{
 const {runInNewContext}=require('node:vm');
 const window={ChartsHubCompanion:{initialLanguage:'en'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
 runInNewContext(read('companion/ui/localization.js'),{window,document,CustomEvent:class {}});
 const language=window.ChartshubCompanionLanguage;
 const summary='1 copie(s) sélectionnée(s) · 42 000 octets. 2 autre(s) copie(s) non cochée(s) restent en place. La version conservée est protégée.';
 assert.equal(language.translate(summary),'1 selected copy/copies · 42 000 bytes. 2 other unchecked copy/copies stay in place. The kept version is protected.');
 assert.equal(language.translate('Envoyer les 2 copies sélectionnées à la Corbeille…'),'Send the 2 selected copies to the Recycle Bin…');
 assert.equal(language.translate('Version conservée · exclue du nettoyage'),'Kept version · excluded from cleanup');
 assert.equal(language.translate('Cette version n’a pas été vérifiée lors du scan. Relancez le scan de la bibliothèque puis comparez les versions.'),'This version was not verified during the scan. Scan the library again, then compare the versions.');
 assert.equal(language.translate('Cette version a changé depuis le scan ou la comparaison. Relancez le scan de la bibliothèque puis comparez les versions.'),'This version has changed since the scan or comparison. Scan the library again, then compare the versions.');
 const available='2 copie(s) vérifiée(s) disponible(s). Cochez individuellement les copies à envoyer à la Corbeille. 1 version(s) vérifiée(s) mais différente(s) peuvent être supprimées manuellement. 3 version(s) restent protégées. Aucune copie n’est sélectionnée automatiquement.';
 assert.equal(language.translate(available),'2 verified copy/copies available. Select each copy to send to the Recycle Bin individually. 1 verified but different version(s) can be deleted manually. 3 version(s) remain protected. No copy is selected automatically.');
 assert.equal(language.translate('1 copie(s) vérifiée(s) disponible(s). Cochez individuellement les copies à envoyer à la Corbeille. Aucune copie n’est sélectionnée automatiquement.'),'1 verified copy/copies available. Select each copy to send to the Recycle Bin individually. No copy is selected automatically.');
 language.apply('fr'); assert.equal(language.translate(summary),summary); assert.equal(document.documentElement.lang,'fr');
});
