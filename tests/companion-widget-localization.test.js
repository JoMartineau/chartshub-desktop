'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {publicTelemetrySnapshot}=require('../companion/clonehero-telemetry-view.cjs');

function localizer(language){const window={ChartsHubCompanion:{initialLanguage:language}},document={documentElement:{lang:language},readyState:'loading',body:null,addEventListener(){}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../companion/ui/localization.js'),'utf8'),{window,document});return window.ChartshubCompanionLanguage;}
test('All thirteen registered widget names and their dynamic accessibility labels translate to English',async()=>{
  const {createDefaultRegistry}=await import('../companion/dist/widgets/core/index.js'),{widgetLabel}=await import('../companion/dist/widgets/engine/WidgetLabels.js');
  const ui=localizer('en');
  const expected=['Song title','Artist','Charter','Instrument','Difficulty','Accuracy · timing','Combo and session best','FC tracking','Song progress','Personal best comparison','Session goal','Last five attempts','Synchronized lyrics'];
  const names=createDefaultRegistry().getAll().map(({definition})=>ui.translate(widgetLabel(definition.type)));assert.deepEqual(names,expected);
  for(const name of ['Titre du morceau','Accuracy · précision','Paroles synchronisées']){
    assert.equal(ui.translate('Taille du texte · '+name),'Text size · '+ui.translate(name));
    assert.equal(ui.translate('Réduire le texte · '+name),'Decrease text size · '+ui.translate(name));
    assert.equal(ui.translate('Agrandir le texte · '+name),'Increase text size · '+ui.translate(name));
    assert.equal(ui.translate(name+' · masqué'),ui.translate(name)+' · hidden');
  }
  for(const [fr,en]of [['haut','top'],['haut droite','top right'],['droite','right'],['bas droite','bottom right'],['bas','bottom'],['bas gauche','bottom left'],['gauche','left'],['haut gauche','top left']])assert.equal(ui.translate('Redimensionner : '+fr),'Resize: '+en);
  assert.equal(ui.translate('Destination : overlay du jeu'),'Destination: game overlay');assert.equal(ui.translate('Non affiché dans le jeu'),'Not displayed in the game');
});
test('Known instrument and difficulty vocabulary follows language without changing raw selectors or custom names',async()=>{
  const selectors=await import('../companion/dist/widgets/engine/WidgetSelectors.js');
  for(const [en,fr]of [['Guitar','Guitare'],['Bass','Basse'],['Drums','Batterie'],['Pro Drums','Batterie pro'],['Vocals','Chant'],['Keys','Clavier'],['Guitar Co-op','Guitare coop'],['Rhythm','Guitare rythmique'],['Guitar 6-fret','Guitare 6 frettes'],['Guitar Co-op 6-fret','Guitare coop 6 frettes'],['Rhythm 6-fret','Rythmique 6 frettes'],['Bass 6-fret','Basse 6 frettes']]){
    const state={nowPlaying:{instrument:en,difficulty:'Easy'},performance:{language:'fr'}};assert.equal(selectors.selectLocalizedInstrument(state),fr);assert.equal(selectors.selectInstrument(state),en);assert.equal(selectors.selectLocalizedDifficulty(state),'Facile');state.performance.language='en';state.nowPlaying.instrument=fr;assert.equal(selectors.selectLocalizedInstrument(state),en);
  }
  for(const [en,fr]of [['Easy','Facile'],['Medium','Moyen'],['Hard','Difficile'],['Expert','Expert']]){const state={nowPlaying:{difficulty:en},performance:{language:'fr'}};assert.equal(selectors.selectLocalizedDifficulty(state),fr);state.performance.language='en';state.nowPlaying.difficulty=fr;assert.equal(selectors.selectLocalizedDifficulty(state),en);}
  const unknown={nowPlaying:{instrument:'Custom instrument',difficulty:'Custom difficulty'},performance:{language:'fr'}};assert.equal(selectors.selectLocalizedInstrument(unknown),'Custom instrument');assert.equal(selectors.selectLocalizedDifficulty(unknown),'Custom difficulty');assert.equal(selectors.selectLocalizedInstrument({nowPlaying:{instrument:'Guitar'}}),'Guitar');assert.equal(selectors.selectLocalizedDifficulty({nowPlaying:null}),null);
});
test('Game and OBS renderer models localize vocabulary while preserving literal titles, creators, lyrics and metadata',async()=>{
  const {createDefaultRegistry,createDefaultWidgets}=await import('../companion/dist/widgets/core/index.js'),{createGameplayWidgets}=await import('../companion/dist/widgets/core/Gameplay/GameplayWidgets.js'),{WidgetRenderer}=await import('../companion/dist/widgets/engine/WidgetRenderer.js');
  // These are literal fixture words, not real artist names.
  const nowPlaying={title:'Easy',artist:'Guitar',charter:'Clavier',instrument:'Guitar',difficulty:'Easy'},original=structuredClone(nowPlaying);
  const state={gameplay:{state:'playing',isChartActive:true},nowPlaying,serviceHealth:{},performance:publicTelemetrySnapshot({connected:false,status:'waiting'},'fr'),lyrics:{current:'Guitar Easy',next:null},widgets:{instances:[...createDefaultWidgets(),...createGameplayWidgets()].map(w=>({...w,enabled:true,visibility:{game:true,stream:true}}))}};
  const renderer=new WidgetRenderer(createDefaultRegistry());
  for(const destination of ['game','stream']){
    for(const language of ['fr','en']){state.performance.language=language;const models=renderer.renderWidgetModels(state,destination),text=type=>models.find(w=>w.type===type)?.text;assert.equal(text('song.instrument'),language==='fr'?'Guitare':'Guitar');assert.equal(text('song.difficulty'),language==='fr'?'Facile':'Easy');assert.equal(text('song.title'),'Easy');assert.equal(text('song.artist'),'Guitar');assert.equal(text('song.charter'),'Clavier');assert.equal(text('song.lyrics'),'Guitar Easy');}
  }
  assert.deepEqual(nowPlaying,original);
  assert.equal(localizer('fr').translate('Titre du morceau'),'Titre du morceau');
});
