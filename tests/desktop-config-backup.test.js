'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createConfigBackup,MAX_BYTES}=require('../desktop/config-backup.cjs');
const {DEFAULT_WIDGET}=require('../companion/song-request-widget.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(t,{hook,clock,onChange}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(process.env.CHARTSHUB_UPDATE_TEST_ROOT||os.tmpdir(),'chartshub-backup-fixture-')));
 t.after(async()=>{assert(path.isAbsolute(root)&&path.basename(root).startsWith('chartshub-backup-fixture-'));await fs.rm(root,{recursive:true,force:true});});
 const engine=await createConfigBackup({directory:root,version:'0.14.27',hook,clock,onChange}),bundle=JSON.parse((await engine.exportDocument()).bytes);
 const settings={version:3,...bundle.groups.overlay,stream:{port:41000,...bundle.groups.overlay.stream}};
 await fs.writeFile(path.join(root,'settings.json'),JSON.stringify(settings)+'\n');
 const requests={version:2,port:42000,rules:{maxDurationMinutes:8,instrument:'guitar',difficulty:'expert'},ingestToken:'a'.repeat(64),readToken:'b'.repeat(64),widget:{...DEFAULT_WIDGET}};
 await fs.writeFile(path.join(root,'song-request-access.json'),JSON.stringify(requests)+'\n');
 return {root,engine,settings,requests,bundle,read:async name=>fs.readFile(path.join(root,name),'utf8')};
}
async function indexJournal(root,directory){const pending=path.join(root,'.configuration-pending');await fs.mkdir(pending,{recursive:true});await fs.writeFile(path.join(pending,path.basename(directory)+'.json'),JSON.stringify({version:1,id:path.basename(directory),journalSha256:hash(await fs.readFile(path.join(directory,'journal.json')))}));}
test('portable export strips capabilities, account data, local paths, ports and arbitrary widget config',async t=>{
 const f=await fixture(t);f.settings.widgets[0].config={token:'SECRET_FIXTURE',path:'C:/PrivateFixture/Songs'};f.settings.localPath='C:/PrivateFixture';await fs.writeFile(path.join(f.root,'settings.json'),JSON.stringify(f.settings));
 await fs.writeFile(path.join(f.root,'song-request-accounts.json'),'{"token":"ACCOUNT_FIXTURE_SECRET"}');
 const exported=await f.engine.exportDocument(),text=exported.bytes.toString(),document=JSON.parse(text);
 for(const forbidden of ['SECRET_FIXTURE','PrivateFixture','ACCOUNT_FIXTURE_SECRET',f.requests.ingestToken,f.requests.readToken,'ingestToken','readToken','41000','42000'])assert(!text.includes(forbidden));
 assert.deepEqual(document.groups.overlay.widgets[0].config,{});assert.deepEqual(document.groups.requests,DEFAULT_WIDGET);assert.deepEqual(Object.keys(document.groups.overlay.stream),['canvas','layout']);assert.equal(exported.summary.groups.find(g=>g.key==='requests').count,1);
});
test('widget restore changes only the visual whitelist and retains local tokens, port and rules',async t=>{
 const f=await fixture(t),doc=JSON.parse((await f.engine.exportDocument()).bytes);doc.groups={requests:{...DEFAULT_WIDGET,accentColor:'#f59e0b',fontSize:32,upcomingCount:1,showNowPlaying:false,showViewerNames:false}};
 const preview=await f.engine.previewBytes(Buffer.from(JSON.stringify(doc)));assert.equal(preview.groups[0].key,'requests');assert.equal((await f.engine.apply(preview.id,{quiesced:true})).applied,true);
 const after=JSON.parse(await f.read('song-request-access.json'));for(const key of ['ingestToken','readToken','port','rules'])assert.deepEqual(after[key],f.requests[key]);assert.deepEqual(after.widget,doc.groups.requests);assert.equal(f.engine.status().preview,null);
});
test('preview is opaque and writes nothing; apply requires that preview plus explicit quiescence',async t=>{
 const f=await fixture(t),before=await f.read('settings.json'),bytes=(await f.engine.exportDocument()).bytes,preview=await f.engine.previewBytes(bytes);
 assert.match(preview.id,/^[a-f0-9-]{36}$/);assert(!JSON.stringify(preview).includes(f.root));assert.equal(await f.read('settings.json'),before);assert.equal((await fs.readdir(f.root)).includes('.configuration-backups'),false);
 await assert.rejects(()=>f.engine.apply(preview.id),{code:'BACKUP_PREVIEW_EXPIRED'});f.engine.cancel(preview.id);await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_PREVIEW_EXPIRED'});
});
test('unknown/future/oversized imports and embedded widget strings are rejected before writes',async t=>{
 const f=await fixture(t),base=JSON.parse((await f.engine.exportDocument()).bytes),before=await f.read('settings.json');
 for(const mutate of [x=>x.version=2,x=>x.groups.account={token:'fixture'},x=>x.groups.requests.token='fixture',x=>x.groups.overlay.widgets[0].config={path:'C:/Private'},x=>x.groups.overlay.stream.port=99,x=>x.sourceVersion='x']){const doc=structuredClone(base);mutate(doc);await assert.rejects(()=>f.engine.previewBytes(Buffer.from(JSON.stringify(doc))));}
 await assert.rejects(()=>f.engine.previewBytes(Buffer.alloc(MAX_BYTES+1)),{code:'BACKUP_TOO_LARGE'});assert.equal(await f.read('settings.json'),before);
});
test('an edited current file invalidates preview without replacing any file',async t=>{
 const f=await fixture(t),preview=await f.engine.previewBytes((await f.engine.exportDocument()).bytes),changed=JSON.stringify({...f.settings,theme:f.settings.theme})+' ';
 await fs.writeFile(path.join(f.root,'settings.json'),changed);await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_CHANGED'});assert.equal(await f.read('settings.json'),changed);assert.equal((await fs.readdir(f.root)).includes('.configuration-import.lock'),false);
});
test('failure after the first publication rolls back every original byte and retains recovery copies',async t=>{
 const f=await fixture(t,{hook:async(phase)=>{if(phase==='written')throw Error('Synthetic failure');}}),originalSettings=await f.read('settings.json'),originalRequests=await f.read('song-request-access.json'),preview=await f.engine.previewBytes((await f.engine.exportDocument()).bytes);
 await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_WRITE_FAILED'});assert.equal(await f.read('settings.json'),originalSettings);assert.equal(await f.read('song-request-access.json'),originalRequests);const directories=await fs.readdir(path.join(f.root,'.configuration-backups'));assert.equal(directories.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.configuration-backups',directories[0],'failed.json'),'utf8')).state,'rolled-back');
});
test('concurrent replacement is preserved rather than overwritten by rollback',async t=>{
 let external;const f=await fixture(t,{hook:async(phase,{target})=>{if(phase==='original-moved'&&!external){external=target;await fs.writeFile(target,'external concurrent fixture');}}}),before=await f.read('settings.json'),preview=await f.engine.previewBytes((await f.engine.exportDocument()).bytes);
 await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_RECOVERY_REQUIRED'});assert.equal(await fs.readFile(external,'utf8'),'external concurrent fixture');const directories=await fs.readdir(path.join(f.root,'.configuration-backups'));assert.equal(await fs.readFile(path.join(f.root,'.configuration-backups',directories[0],'overlay.original.json'),'utf8'),before);
});
test('startup rolls back an interrupted owned transaction before settings are loaded',async t=>{
 const f=await fixture(t),old=Buffer.from(await f.read('settings.json')),newBytes=Buffer.from(JSON.stringify({...f.settings,stream:{...f.settings.stream,port:43000}})),id=crypto.randomUUID(),directory=path.join(f.root,'.configuration-backups',id);await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(path.join(directory,'overlay.original.json'),old);await fs.rename(path.join(f.root,'settings.json'),path.join(directory,'overlay.moved.json'));await fs.writeFile(path.join(directory,'overlay.new.json'),newBytes);await fs.link(path.join(directory,'overlay.new.json'),path.join(f.root,'settings.json'));
 await fs.writeFile(path.join(directory,'journal.json'),JSON.stringify({version:1,state:'prepared',groups:[{key:'overlay',oldSha:hash(old),newSha:hash(newBytes)}]}));await fs.writeFile(path.join(f.root,'.configuration-import.lock'),JSON.stringify({version:1,pid:424242,transactionId:id}));
 await indexJournal(f.root,directory);await createConfigBackup({directory:f.root,version:'0.14.27',isProcessAlive:()=>false});assert.equal(await f.read('settings.json'),old.toString());assert.equal((await fs.stat(path.join(f.root,'settings.json'))).nlink,1);await assert.rejects(()=>fs.stat(path.join(f.root,'.configuration-import.lock')),{code:'ENOENT'});
});
test('startup never overwrites an unknown edit in an interrupted transaction',async t=>{
 const f=await fixture(t),old=Buffer.from(await f.read('settings.json')),id=crypto.randomUUID(),directory=path.join(f.root,'.configuration-backups',id);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'overlay.original.json'),old);await fs.rename(path.join(f.root,'settings.json'),path.join(directory,'overlay.moved.json'));await fs.writeFile(path.join(f.root,'settings.json'),'external edit');await fs.writeFile(path.join(directory,'journal.json'),JSON.stringify({version:1,state:'prepared',groups:[{key:'overlay',oldSha:hash(old),newSha:'a'.repeat(64)}]}));
 await indexJournal(f.root,directory);await assert.rejects(()=>createConfigBackup({directory:f.root,version:'0.14.27'}),{code:'BACKUP_RECOVERY_REQUIRED'});assert.equal(await f.read('settings.json'),'external edit');assert.equal(await fs.readFile(path.join(directory,'overlay.moved.json'),'utf8'),old.toString());
});
test('all five visual groups round-trip without changing local stream access or account files',async t=>{
 const f=await fixture(t),base=JSON.parse((await f.engine.exportDocument()).bytes),appearance={backgroundColor:'#151719e6',textColor:'#eef1f2',fontFamily:'consolas',fontSize:18},bloom=await import('../companion/ui/ui-bloom-model.js');
 await fs.writeFile(path.join(f.root,'overlay-profiles.json'),JSON.stringify({version:1,revision:2,items:[{id:crypto.randomUUID(),name:'Fixture evening',updatedAt:'2026-10-24T00:00:00.000Z',document:base.groups.overlay}]}));await fs.writeFile(path.join(f.root,'floating-panels.json'),JSON.stringify({version:2,revision:3,appearance:{catalogue:appearance,filters:appearance,player:appearance}}));await fs.writeFile(path.join(f.root,'ui-bloom.json'),JSON.stringify({...bloom.DEFAULTS,enabled:true,hoverLift:5}));await fs.writeFile(path.join(f.root,'accounts.json'),'account fixture retained');
 const exported=await f.engine.exportDocument();assert.deepEqual(exported.summary.groups.map(g=>g.key),['overlay','profiles','panels','bloom','requests']);const preview=await f.engine.previewBytes(exported.bytes);await f.engine.apply(preview.id,{quiesced:true});assert.equal(JSON.parse(await f.read('settings.json')).stream.port,41000);assert.equal(JSON.parse(await f.read('overlay-profiles.json')).items[0].name,'Fixture evening');assert.equal(JSON.parse(await f.read('floating-panels.json')).appearance.player.fontSize,18);assert.equal(JSON.parse(await f.read('ui-bloom.json')).hoverLift,5);assert.equal(await f.read('accounts.json'),'account fixture retained');assert.equal(JSON.parse(await f.read('song-request-access.json')).ingestToken,f.requests.ingestToken);
});
test('valid profiles larger than the portable bundle limit still import and roll back byte-for-byte',async t=>{
 for(const inject of [false,true]){
  const f=await fixture(t,{hook:async(phase,entry)=>{if(inject&&phase==='written'&&entry.key==='profiles')throw Error('Synthetic failure after profile publication');}}),old=Buffer.from(JSON.stringify({version:1,revision:0,items:[]})+' '.repeat(MAX_BYTES+100));await fs.writeFile(path.join(f.root,'overlay-profiles.json'),old);const exported=await f.engine.exportDocument();assert(exported.bytes.length<MAX_BYTES);const preview=await f.engine.previewBytes(exported.bytes);
  if(inject){await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_WRITE_FAILED'});assert.equal(hash(await fs.readFile(path.join(f.root,'overlay-profiles.json'))),hash(old));}
  else{await f.engine.apply(preview.id,{quiesced:true});assert.deepEqual(JSON.parse(await f.read('overlay-profiles.json')).items,[]);const dirs=await fs.readdir(path.join(f.root,'.configuration-backups'));assert.equal(hash(await fs.readFile(path.join(f.root,'.configuration-backups',dirs[0],'profiles.original.json'))),hash(old));}
 }
});
test('startup recovery retains the larger original profile-file bound',async t=>{
 const f=await fixture(t),old=Buffer.from(JSON.stringify({version:1,revision:0,items:[]})+' '.repeat(MAX_BYTES+100)),newBytes=Buffer.from('{"version":1,"revision":1,"items":[]}'),directory=path.join(f.root,'.configuration-backups',crypto.randomUUID());await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'profiles.original.json'),old);await fs.writeFile(path.join(directory,'profiles.moved.json'),old);await fs.writeFile(path.join(f.root,'overlay-profiles.json'),newBytes);await fs.writeFile(path.join(directory,'journal.json'),JSON.stringify({version:1,state:'prepared',groups:[{key:'profiles',oldSha:hash(old),newSha:hash(newBytes)}]}));await indexJournal(f.root,directory);await createConfigBackup({directory:f.root,version:'0.14.27'});assert.equal(hash(await fs.readFile(path.join(f.root,'overlay-profiles.json'))),hash(old));
});
test('expired preview disappears and is rejected before application shutdown can be requested',async t=>{
 let now=0;const notifications=[],f=await fixture(t,{clock:()=>now,onChange:state=>notifications.push(state)}),preview=await f.engine.previewBytes((await f.engine.exportDocument()).bytes);assert.equal(f.engine.assertPreview(preview.id),true);now=10*60000;assert.equal(f.engine.status().preview,null);assert.throws(()=>f.engine.assertPreview(preview.id),{code:'BACKUP_PREVIEW_EXPIRED'});await assert.rejects(()=>f.engine.apply(preview.id,{quiesced:true}),{code:'BACKUP_PREVIEW_EXPIRED'});await new Promise(resolve=>setImmediate(resolve));assert(notifications.some(value=>value.preview===null));
});
test('more than one hundred completed archives never block startup and unknown pending records stay untouched',async t=>{
 const f=await fixture(t),parent=path.join(f.root,'.configuration-backups'),before=await f.read('settings.json');await fs.mkdir(parent);
 for(let n=0;n<101;n++){const directory=path.join(parent,crypto.randomUUID()),journal=Buffer.from(JSON.stringify({version:1,state:'prepared',groups:[{key:'bloom',oldSha:null,newSha:'a'.repeat(64)}]}));await fs.mkdir(directory);await fs.writeFile(path.join(directory,'journal.json'),journal);await fs.writeFile(path.join(directory,'complete.json'),JSON.stringify({version:2,state:'complete',journalSha256:hash(journal)}));}
 await createConfigBackup({directory:f.root,version:'0.14.27'});assert.equal((await fs.readdir(parent)).length,101);assert.equal(await f.read('settings.json'),before);
 const pending=path.join(f.root,'.configuration-pending');await fs.mkdir(pending);const unknown=path.join(pending,crypto.randomUUID()+'.json');await fs.writeFile(unknown,'{"unknown":"fixture"}');await assert.rejects(()=>createConfigBackup({directory:f.root,version:'0.14.27'}),{code:'BACKUP_RECOVERY_REQUIRED'});assert.equal(await fs.readFile(unknown,'utf8'),'{"unknown":"fixture"}');assert.equal((await fs.readdir(parent)).length,101);
});
