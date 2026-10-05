'use strict';
const {app,dialog}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {registerCompanionScheme,createCompanionHost}=require('../companion/host.cjs');

const directory=path.resolve(process.argv[2]||path.join(__dirname,'..','..','companion-language-verification'));
app.setPath('userData',path.join(directory,'profile'));
app.disableHardwareAcceleration();
registerCompanionScheme();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,label){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await delay(35);}throw Error('Timed out: '+label);}
const filtersState={rootPath:null,supported:true,installed:false,binaryAvailable:true,restoreAvailable:false,running:false,busy:false,state:'not-installed',message:'Fixture filters',error:null,native:null,settings:{enabled:false,saturation:1,contrast:1,gamma:1,exposure:0,sharpness:0,vignette:0}};
const reshadeState={rootPath:null,supported:true,installed:false,binaryAvailable:true,running:false,connected:false,busy:false,state:'not-installed',message:'Fixture ReShade',error:null,catalog:null};
const setupState={state:'idle',busy:false,rootPath:null,includeStarterEffects:false,version:null,message:'Fixture setup',error:null,progress:null,files:[]};
const filtersService={async load(){},status:()=>structuredClone(filtersState),async refresh(){},async setSettings(){},async selectRoot(){},async install(){},async restore(){},async dispose(){}};
const reshadeService={async load(){},status:()=>structuredClone(reshadeState),async refresh(){},async selectRoot(){},async install(){},async command(){},async dispose(){}};
const reshadeSetupService={async load(){},status:()=>structuredClone(setupState),async prepare(){},async cancel(){},async install(){},async dispose(){}};
let host,panel;
const fail=async error=>{console.error(error);try{await host?.dispose();}catch{}app.exit(1);};
setTimeout(()=>void fail(Error('Companion language test timeout')),45000).unref();

app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});
 host=await createCompanionHost({
  dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),
  filtersService,reshadeService,reshadeSetupService,
  catalogueClient:{async load(){return {items:[],revision:'lang-fixture',demo:false};},async artwork(){throw Error('No network');}},
  downloadWorker:{async run(){throw Error('No downloads');},async discard(){},async resolveCompleted(){return null;}}
 });
 host.setLanguage('en');
 panel=await host.open();
 const web=panel.webContents,run=code=>web.executeJavaScript(code);
 await waitFor(()=>run("!!window.ChartshubCompanionLanguage&&document.documentElement.lang==='en'&&document.querySelector('#library-title')?.textContent==='Local library'"),'initial English UI');
 assert.equal(await run("document.querySelector('#source-mode-label').textContent"),'DEMO MODE');
 assert.equal(await run("document.querySelector('#profiles-title').textContent"),'Overlay profiles');
 assert.equal(await run("document.querySelector('#library-verify-all-duplicates').textContent"),'Verify audio for all duplicates');
 assert.equal(await run("document.querySelector('#catalogue-title').textContent"),'ChartsHub Catalogue');
 assert.equal(await run("document.querySelector('#downloads-title').textContent"),'Downloads');
 const untranslated=await run(`(()=>{
  const blocked='code,pre,script,style,.companion-widget,.library-relative-path,.library-variant-path,.library-variant h4,.library-variant-metadata,.catalogue-item h3,.catalogue-item-artist,.catalogue-item-details,.download-item h3,.download-destination,.profile-item-name,#clonehero-file-path,#library-root,#downloads-root,#reshade-root,#filters-root,#reshade-preset';
  const pattern=/[éèêàâçîïôûùüœ]|\\b(?:Aucun|Choisir|Chargement|Enregistrer|Supprimer|Annuler|Actualiser|Réglages|Morceau|Démonstration|Connexion|Afficher|Masqué|Activer|Désactiver|Indisponible|Bibliothèque|Téléchargement|Profil|Rechercher|Sélectionnez|Fermez|Installer|Restaurer|Vérification|Préparation|Disposition|Corbeille|nettoyage|analyse|serveur|fichier|fichiers|copie|copies|groupe|groupes)\\b/i;
  const values=[];
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode())){const parent=node.parentElement,text=node.nodeValue.trim();if(!text||parent?.closest(blocked)||!pattern.test(text))continue;values.push(text);}
  return [...new Set(values)].slice(0,200);
 })()`);
 const frenchOnly=untranslated.filter(value=>/[àâçéèêëîïôùûüÿœ]|\b(?:Choisissez|Chargement|Enregistrer|Supprimer|Annuler|Actualiser|Réglages|Morceau|Démonstration|Connexion|Afficher|Masqué|Activer|Désactiver|Indisponible|Bibliothèque|Téléchargement|Profil|Rechercher|Sélectionnez|Fermez|Installer|Restaurer|Vérification|Préparation|Disposition|Corbeille|nettoyage|analyse|serveur)\b/i.test(value));
 assert.deepEqual(frenchOnly,[],'English Companion must not retain French interface strings');

 // User-controlled content that happens to equal a French UI word must never be translated.
 const preserved=await run(`(()=>{
  const song=document.createElement('h3');song.className='catalogue-user-fixture';song.textContent='Artiste';
  const card=document.createElement('article');card.className='catalogue-item';card.append(song);document.body.append(card);
  const profile=document.createElement('span');profile.className='profile-item-name';profile.textContent='Créateur';document.body.append(profile);
  window.ChartshubCompanionLanguage.refresh();
  return {song:song.textContent,profile:profile.textContent};
 })()`);
 assert.deepEqual(preserved,{song:'Artiste',profile:'Créateur'});

 const originalOpen=dialog.showOpenDialog;let chooserTitle='';
 dialog.showOpenDialog=async(_owner,options)=>{chooserTitle=options.title;return {canceled:true,filePaths:[]};};
 try{
  const result=await run("window.ChartsHubCompanion.command('library.chooseRoot')");
  assert.equal(result.ok,true);assert.equal(chooserTitle,'Choose Clone Hero Songs folder');
 }finally{dialog.showOpenDialog=originalOpen;}

 host.setLanguage('fr');
 await waitFor(()=>run("document.documentElement.lang==='fr'&&document.querySelector('#library-title')?.textContent==='Bibliothèque locale'"),'French switch');
 assert.equal(await run("document.querySelector('#source-mode-label').textContent"),'MODE DÉMO');
 assert.equal(await run("document.querySelector('#profiles-title').textContent"),'Profils d’overlay');
 assert.equal(await run("document.querySelector('#library-verify-all-duplicates').textContent"),"Vérifier l’audio de tous les doublons");

 host.setLanguage('en');
 await waitFor(()=>run("document.documentElement.lang==='en'&&document.querySelector('#library-title')?.textContent==='Local library'"),'English switch again');
 assert.deepEqual(await run("({song:document.querySelector('.catalogue-user-fixture').textContent,profile:document.querySelector('.profile-item-name').textContent})"),{song:'Artiste',profile:'Créateur'});

 console.log(JSON.stringify({result:'COMPANION_LANGUAGE_SYNC_VERIFIED',switches:['en','fr','en'],userContentPreserved:true,chooserTitle}));
 await host.dispose();app.exit(0);
}).catch(fail);
