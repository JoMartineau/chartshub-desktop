'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createConfigBackup}=require('../desktop/config-backup.cjs');
const modules=Promise.all([import('../companion/dist/widgets/core/index.js'),import('../companion/dist/themes/ThemeService.js'),import('../companion/dist/overlay/stream/StreamConfig.js'),import('../companion/dist/storage/SettingsRepository.js')]).then(([core,theme,stream,storage])=>({...core,...theme,...stream,...storage}));
async function fixture(t,document,hook){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-backup-widgets-'))),file=path.join(directory,'settings.json');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 if(document)await fs.writeFile(file,JSON.stringify(document));
 const engine=await createConfigBackup({directory,version:'0.14.31',hook});
 return {directory,file,engine,read:async()=>JSON.parse(await fs.readFile(file,'utf8')),write:document=>fs.writeFile(file,JSON.stringify(document))};
}
async function factory(){const a=await modules,widgets=a.createDefaultWidgets();return a.ensureGameplayDocument(a.validateSettings({version:3,widgets,theme:a.createDefaultTheme(),stream:a.createDefaultStream(widgets)}));}
const widget=(document,id)=>document.widgets.find(w=>w.id===id);
test('all thirteen actual registered factory widgets export and restore with independent game and stream layouts',async t=>{
 const source=await factory(),a=await modules;
 assert.equal(source.widgets.length,13);assert.deepEqual(source.widgets.map(w=>w.type).sort(),a.createDefaultRegistry().getAll().map(w=>w.definition.type).sort());
 const f=await fixture(t,source),exported=await f.engine.exportDocument(),bundle=JSON.parse(exported.bytes);
 assert.equal(exported.summary.groups.find(g=>g.key==='overlay').count,13);assert.deepEqual(bundle.groups.overlay.widgets,source.widgets);
 const changed=structuredClone(source);widget(changed,'gameplay-combo').position={x:512,y:222};changed.stream.port=41000;await f.write(changed);
 const preview=await f.engine.previewBytes(exported.bytes);assert.equal((await f.engine.apply(preview.id,{quiesced:true})).applied,true);
 const restored=await f.read();assert.deepEqual(restored.widgets,source.widgets);assert.deepEqual(restored.theme,source.theme);assert.deepEqual(restored.stream.layout,source.stream.layout);assert.equal(restored.stream.port,41000);
});
test('recovered twelve-widget Accuracy choices and positions survive; host migration adds only factory lyrics',async t=>{
 const source=await factory();source.widgets=source.widgets.filter(w=>w.id!=='song-lyrics');source.stream.layout=source.stream.layout.filter(w=>w.id!=='song-lyrics');
 const accuracy=widget(source,'gameplay-accuracy');accuracy.config={fields:['lastOffsetMs','meanOffsetMs'],showTitle:false,showCoverage:false};accuracy.position={x:385,y:522};accuracy.size={width:450,height:110};accuracy.style.fontSize=24;
 Object.assign(source.stream.layout.find(w=>w.id===accuracy.id),{x:31,y:43,width:300,height:140});
 const f=await fixture(t,source),exported=await f.engine.exportDocument();assert.equal(JSON.parse(exported.bytes).groups.overlay.widgets.length,12);
 const changed=structuredClone(source);widget(changed,accuracy.id).config={};await f.write(changed);
 const preview=await f.engine.previewBytes(exported.bytes);await f.engine.apply(preview.id,{quiesced:true});const restored=await f.read();
 assert.deepEqual(restored,source);const a=await modules,migrated=a.ensureGameplayDocument(a.validateSettings(restored));assert.equal(migrated.widgets.length,13);
 assert.deepEqual(migrated.widgets.slice(0,12),source.widgets);assert.deepEqual(migrated.stream.layout.slice(0,12),source.stream.layout);
 assert.deepEqual(widget(migrated,'song-lyrics'),widget(await factory(),'song-lyrics'));assert.deepEqual(widget(migrated,accuracy.id).config,accuracy.config);
});
test('legacy five-widget v1, v2 and v3 settings remain exportable and restorable',async t=>{
 const a=await modules;
 for(const version of [1,2,3]){
  const widgets=a.createDefaultWidgets(),source={version,widgets,...(version>=2?{theme:a.createDefaultTheme()}:{}),...(version===3?{stream:{...a.createDefaultStream(widgets),port:41000}}:{})};
  const f=await fixture(t,source),exported=await f.engine.exportDocument(),preview=await f.engine.previewBytes(exported.bytes);await f.engine.apply(preview.id,{quiesced:true});
  const restored=await f.read();assert.equal(restored.widgets.length,5);assert.deepEqual(restored,a.validateSettings(source));
 }
});
test('Accuracy and lyrics public options round-trip through saved profiles while private legacy config is stripped',async t=>{
 const source=await factory(),accuracy=widget(source,'gameplay-accuracy'),lyrics=widget(source,'song-lyrics');accuracy.config={fields:['sampleCount','withinWindowPercent'],showTitle:true,showCoverage:false};lyrics.config={showNextLine:true};
 const f=await fixture(t,source),publicDoc=JSON.parse((await f.engine.exportDocument()).bytes).groups.overlay;
 const profile={version:1,revision:7,items:[{id:crypto.randomUUID(),name:'Fixture thirteen widgets',updatedAt:'2026-10-31T12:00:00.000Z',document:structuredClone(publicDoc)}]};
 for(const w of profile.items[0].document.widgets)w.config={...w.config,path:'C:/PRIVATE_SONGS_FIXTURE',token:'PRIVATE_TOKEN_FIXTURE',history:[{title:'PRIVATE_HISTORY_FIXTURE'}]};
 await fs.writeFile(path.join(f.directory,'overlay-profiles.json'),JSON.stringify(profile));
 const dirty=structuredClone(source);for(const w of dirty.widgets)w.config={...w.config,path:'C:/PRIVATE_SONGS_FIXTURE',token:'PRIVATE_TOKEN_FIXTURE'};dirty.performance={history:[{title:'PRIVATE_HISTORY_FIXTURE'}]};await f.write(dirty);
 const exported=await f.engine.exportDocument(),text=exported.bytes.toString(),bundle=JSON.parse(text);
 for(const forbidden of ['PRIVATE_SONGS_FIXTURE','PRIVATE_TOKEN_FIXTURE','PRIVATE_HISTORY_FIXTURE','"port"'])assert.equal(text.includes(forbidden),false);
 assert.deepEqual(bundle.groups.overlay,publicDoc);assert.deepEqual(bundle.groups.profiles.items[0].document,publicDoc);
 // Import into a valid current document; unrelated unreadable current settings
 // retain the existing conservative refusal to replace them during apply.
 await f.write(source);
 const preview=await f.engine.previewBytes(exported.bytes);await f.engine.apply(preview.id,{quiesced:true});
 assert.deepEqual(widget(await f.read(),'gameplay-accuracy').config,accuracy.config);assert.deepEqual(widget(await f.read(),'song-lyrics').config,lyrics.config);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'overlay-profiles.json'),'utf8')).items[0].document,publicDoc);
});
test('unknown widget types, forged IDs, private configuration and malformed Accuracy/lyrics imports are rejected before writes',async t=>{
 const f=await fixture(t,await factory()),bytes=(await f.engine.exportDocument()).bytes,before=await fs.readFile(f.file,'utf8');
 const mutations=[
  d=>{widget(d,'gameplay-combo').type='future.widget';},d=>{widget(d,'gameplay-combo').id='forged-id';},
  d=>{widget(d,'song-title').config={path:'C:/Private'};},d=>{widget(d,'gameplay-combo').config={history:[]};},
  d=>{widget(d,'gameplay-accuracy').config={path:'C:/Private'};},d=>{widget(d,'gameplay-accuracy').config={fields:['../Songs']};},
  d=>{widget(d,'gameplay-accuracy').config={fields:['lastOffsetMs','lastOffsetMs']};},d=>{widget(d,'gameplay-accuracy').config={fields:[]};},
  d=>{widget(d,'gameplay-accuracy').config={fields:['meanOffsetMs'],showTitle:'false'};},d=>{widget(d,'song-lyrics').config={showNextLine:1};},d=>{widget(d,'song-lyrics').config={filePath:'private.lrc'};}
 ];
 for(const mutate of mutations){const bundle=JSON.parse(bytes);mutate(bundle.groups.overlay);await assert.rejects(()=>f.engine.previewBytes(Buffer.from(JSON.stringify(bundle))));assert.equal(await fs.readFile(f.file,'utf8'),before);}
 const malformed=await factory();widget(malformed,'gameplay-accuracy').config={fields:['invalid']};await f.write(malformed);const badBytes=await fs.readFile(f.file,'utf8');await assert.rejects(()=>f.engine.exportDocument(),{code:'BACKUP_INVALID'});assert.equal(await fs.readFile(f.file,'utf8'),badBytes);
});
test('thirteen-widget restore failures roll back every original byte including Accuracy, lyrics and profiles',async t=>{
 const source=await factory();widget(source,'gameplay-accuracy').config={fields:['lastOffsetMs','meanOffsetMs'],showTitle:false};widget(source,'song-lyrics').config={showNextLine:true};
 const f=await fixture(t,source,async phase=>{if(phase==='written')throw Error('Synthetic publication failure');}),before=await fs.readFile(f.file,'utf8'),preview=await f.engine.previewBytes((await f.engine.exportDocument()).bytes);
 await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_WRITE_FAILED'});assert.equal(await fs.readFile(f.file,'utf8'),before);
 await createConfigBackup({directory:f.directory,version:'0.14.31'});assert.equal(await fs.readFile(f.file,'utf8'),before);
});
