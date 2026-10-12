'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),{setMaxListeners}=require('node:events');
class Element extends EventTarget {
  constructor(owner,tag){super();this.ownerDocument=owner;this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.disabled=false;this.hidden=false;this.checked=false;this.scrollTop=0;this.clientHeight=100;this.scrollHeight=100;this.text='';}
  set textContent(value){this.text=value;this.children=[];}get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_){throw Error('Report text must not be HTML');}append(...children){this.children.push(...children);}setAttribute(key,value){this.attributes[key]=String(value);}
  addEventListener(name,listener,options){if(options?.signal)setMaxListeners(0,options.signal);super.addEventListener(name,listener,options);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}querySelectorAll(selector){const match=entry=>selector.startsWith('#')?entry.id===selector.slice(1):entry.tagName===selector;return this.children.flatMap(entry=>[...(match(entry)?[entry]:[]),...entry.querySelectorAll(selector)]);}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
}
const entry=(id,extra={})=>({id:id.repeat(64),targetRelativePath:'Artist/<Song>',reportedPath:'C:/Songs/Artist/<Song>',severity:'error',reasons:['ERROR: <script>bad</script>'],eligible:true,blocked:null,bytes:55,kind:'folder',...extra});
const plan=(extra={})=>({planId:'a'.repeat(32),revision:1,modifiedAt:'2026-10-12T00:00:00Z',unsupportedLines:0,entries:[entry('a'),entry('b',{severity:'warning',eligible:false,blocked:'warning'})],...extra});
const snapshot=(extra={})=>({library:{settings:{rootPath:'C:/Songs'},revision:1,status:'ready',...extra}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function fixture(t){
  const old={window:globalThis.window,document:globalThis.document},document={documentElement:{lang:'fr'},createElement(tag){return new Element(this,tag);}},window=new EventTarget();
  globalThis.document=document;globalThis.window=window;const root=document.createElement('main'),html=fs.readFileSync(require.resolve('../companion/ui/index.html'),'utf8');
  for(const [,tag,id]of html.matchAll(/<(\w+)\b[^>]*\bid="(library-bad-songs[^"]*)"/g)){const item=document.createElement(tag);item.id=id;root.append(item);}
  const {BadSongsCleanupControls}=await import('../companion/dist/settings/BadSongsCleanupControls.js'),calls=[];
  const controls=new BadSongsCleanupControls({root,command:(name,payload)=>new Promise(resolve=>calls.push({name,payload,resolve}))});controls.update(snapshot());
  t.after(()=>{controls.dispose();for(const key of ['window','document'])if(old[key]===undefined)delete globalThis[key];else globalThis[key]=old[key];});
  const get=selector=>root.querySelector(selector),ui={controls,calls,get,document};
  ui.prepare=async(result=plan())=>{get('#library-bad-songs-import').click();assert.equal(calls.at(-1).name,'library.chooseBadSongs');calls.at(-1).resolve({ok:true,result});await tick();};
  ui.check=id=>get('#library-bad-songs-list').querySelectorAll('input').find(item=>item.dataset.id===id.repeat(64));
  ui.select=id=>{const check=ui.check(id);check.checked=true;check.dispatchEvent(new Event('change'));};return ui;
}
test('import displays report time and reasons as text, with all checkboxes initially clear and warnings disabled',async t=>{
  const ui=await fixture(t);await ui.prepare();assert.equal(ui.check('a').checked,false);assert.equal(ui.check('b').checked,false);assert.equal(ui.check('b').disabled,true);
  assert.equal(ui.get('#library-bad-songs-recycle').disabled,true);assert.match(ui.get('#library-bad-songs-list').textContent,/<script>bad<\/script>/);assert.match(ui.get('#library-bad-songs-status').textContent,/2026-10-12/);
  assert.equal(ui.calls.length,1);assert.equal(ui.calls.some(call=>call.name==='library.scan'),false);
});
test('native confirmation submits only explicitly selected IDs; cancelling preserves the selection',async t=>{
  const ui=await fixture(t);await ui.prepare();ui.select('a');ui.get('#library-bad-songs-recycle').click();ui.get('#library-bad-songs-recycle').click();
  assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[1].payload,{planId:'a'.repeat(32),revision:1,ids:['a'.repeat(64)]});assert.equal(ui.calls[1].name,'library.recycleBadSongs');
  ui.calls[1].resolve({ok:true,cancelled:true});await tick();assert.equal(ui.check('a').checked,true);assert.match(ui.get('#library-bad-songs-status').textContent,/annulée/);
});
test('a successful batch accepts a fresh plan and never invokes an automatic scan',async t=>{
  const ui=await fixture(t);await ui.prepare();ui.select('a');ui.get('#library-bad-songs-recycle').click();ui.controls.update(snapshot({revision:2,badSongsBusy:true}));
  ui.calls[1].resolve({ok:true,result:{recycledIds:['a'.repeat(64)],failed:[],cancelled:false,plan:plan({planId:'c'.repeat(32),revision:2,entries:[entry('b',{severity:'warning',eligible:false,blocked:'warning'})]})}});
  ui.controls.update(snapshot({revision:2}));await tick();assert.equal(ui.check('a'),undefined);assert.equal(ui.check('b').checked,false);assert.equal(ui.check('b').disabled,true);assert.match(ui.get('#library-bad-songs-status').textContent,/Actualiser à la fin/);assert.equal(ui.calls.some(call=>call.name==='library.scan'),false);
});
test('a root or index change discards an old report and a late picker response cannot revive it',async t=>{
  const ui=await fixture(t);ui.get('#library-bad-songs-import').click();ui.controls.update(snapshot({revision:2}));ui.calls[0].resolve({ok:true,result:plan()});await tick();assert.equal(ui.get('#library-bad-songs-plan').hidden,true);
  assert.equal(ui.get('#library-bad-songs-import').disabled,false);await ui.prepare(plan({revision:2}));ui.controls.update(snapshot({revision:3}));assert.equal(ui.get('#library-bad-songs-plan').hidden,true);
});
test('report lists append bounded rows inside their own scroll region',async t=>{
  const ui=await fixture(t),entries=Array.from({length:121},(_,index)=>entry(index.toString(16).padStart(64,'0').slice(0,1),{id:index.toString(16).padStart(64,'0')}));
  await ui.prepare(plan({entries}));const list=ui.get('#library-bad-songs-list');assert.equal(list.children.length,50);list.dispatchEvent(new Event('scroll'));assert.equal(list.children.length,100);list.dispatchEvent(new Event('scroll'));assert.equal(list.children.length,121);
});
test('malformed eligible warnings are rejected and language changes render the controls in English',async t=>{
  const ui=await fixture(t);await ui.prepare(plan({entries:[entry('a',{severity:'warning'})]}));assert.equal(ui.get('#library-bad-songs-plan').hidden,true);
  ui.document.documentElement.lang='en';globalThis.window.dispatchEvent(new Event('chartshub:languagechange'));assert.match(ui.get('#library-bad-songs-status').textContent,/unrecognized/);
});
test('an unselected or duplicate completion receipt cannot claim that a chart was deleted',async t=>{
  for(const recycledIds of [['b'.repeat(64)],['a'.repeat(64),'a'.repeat(64)]]){
    const ui=await fixture(t);await ui.prepare();ui.select('a');ui.get('#library-bad-songs-recycle').click();ui.calls[1].resolve({ok:true,result:{recycledIds,failed:[],cancelled:false}});await tick();
    assert.equal(ui.get('#library-bad-songs-plan').hidden,true);assert.match(ui.get('#library-bad-songs-status').textContent,/Importez à nouveau/);
  }
});
