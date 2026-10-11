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

test('OBS opening confirmation follows live French and English language selection',()=>{
 const {runInNewContext}=require('node:vm');
 const window={ChartsHubCompanion:{initialLanguage:'fr'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
 runInNewContext(read('companion/ui/localization.js'),{window,document,CustomEvent:class {}});
 const language=window.ChartshubCompanionLanguage,message='Fenêtre ouverte. Sélectionnez son titre dans OBS.';
 assert.equal(language.translate(message),message);
 language.apply('en');assert.equal(language.translate(message),'Window opened. Select its title in OBS.');
 language.apply('fr');assert.equal(language.translate(message),message);
});

test('optional ReShade pack follows French and English without implying automatic activation',()=>{
 const {runInNewContext}=require('node:vm');
 const window={ChartsHubCompanion:{initialLanguage:'en'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
 runInNewContext(read('companion/ui/localization.js'),{window,document,CustomEvent:class {}});
 const language=window.ChartshubCompanionLanguage,label='Ajouter le pack Curves, MagicHDR et Technicolor2';
 assert.equal(language.translate(label),'Add the Curves, MagicHDR and Technicolor2 pack');
 assert.equal(language.translate('Ces effets resteront désactivés par défaut. Vous pourrez les choisir après connexion.'),'These effects remain disabled by default. You can choose them after connecting.');
 language.apply('fr');assert.equal(language.translate(label),label);
 const html=read('companion/ui/index.html');assert.ok(html.includes(label));
 assert.match(html,/<input id="reshade-setup-effects" type="checkbox" disabled>/);
});

test('progressive library loading status and retry labels follow French and English',()=>{
 const {runInNewContext}=require('node:vm');
 const window={ChartsHubCompanion:{initialLanguage:'en'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
 runInNewContext(read('companion/ui/localization.js'),{window,document,CustomEvent:class {}});
 const language=window.ChartshubCompanionLanguage;
 assert.equal(language.translate('50 sur 116 résultats affichés'),'50 of 116 results displayed');
 assert.equal(language.translate('50 sur 116 résultats affichés · Chargement de la suite…'),'50 of 116 results displayed · Loading more…');
 assert.equal(language.translate('50 sur 116 résultats affichés · Suite indisponible'),'50 of 116 results displayed · More results unavailable');
 assert.equal(language.translate('Réessayer le chargement'),'Retry loading');
 assert.equal(language.translate('Chargement automatique · lots de 50'),'Automatic loading · batches of 50');
 language.apply('fr');assert.equal(language.translate('50 sur 116 résultats affichés'),'50 sur 116 résultats affichés');
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

test('cleanup history, file differences and interrupted verification follow French and English',()=>{
 const {runInNewContext}=require('node:vm');
 const window={ChartsHubCompanion:{initialLanguage:'en'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
 runInNewContext(read('companion/ui/localization.js'),{window,document,CustomEvent:class {}});
 const language=window.ChartshubCompanionLanguage;
 const messages=[
  ['Historique des nettoyages','Cleanup history'],
  ['Arrêter la vérification','Stop verification'],
  ['Comparer les fichiers · 2 différence(s)','Compare files · 2 difference(s)'],
  ['2 identique(s) · 1 modifié(s) · 0 uniquement dans la version conservée · 1 uniquement dans cette copie · 0 non vérifié(s)','2 identical · 1 changed · 0 only in the kept version · 1 only in this copy · 0 unverified'],
  ['Arrêt de la vérification en cours : 1 / 5 groupes. Les résultats terminés seront conservés.','Stopping verification: 1 / 5 groups. Completed results will be kept.'],
  ['Vérification interrompue : 1 / 5 groupe(s) vérifié(s). 1 groupe(s) prêt(s) · 0 choix de version requis · 0 bloqué(s) · 2 copie(s) vérifiée(s). Aucun fichier n’a été supprimé.','Verification interrupted: 1 / 5 group(s) checked. 1 ready group(s) · 0 keeper choice(s) required · 0 blocked · 2 verified copy/copies. No files were deleted.'],
  ['Le nettoyage est terminé, mais son historique n’a pas pu être enregistré.','Cleanup has finished, but its history could not be saved.']
 ];
 for(const [fr,en] of messages)assert.equal(language.translate(fr),en);
 language.apply('fr'); for(const [fr] of messages)assert.equal(language.translate(fr),fr);
});
