const test=require('node:test'),assert=require('node:assert/strict');
const {applicationMenu,canPreviewVisitor}=require('../app-menu');
test('guest preview is offered only when supplied after verified administrator authorization',()=>{
 for(const user of [null,{}, {emailVerified:true,staffRole:'moderator'},{emailVerified:false,staffRole:'administrator'}])assert.equal(canPreviewVisitor(user),false);
 assert.equal(canPreviewVisitor({emailVerified:true,staffRole:'administrator'}),true);
 assert.equal(applicationMenu({language:'fr'}).some(item=>item.label==='Voir comme visiteur'),false);
 let opened=false;applicationMenu({language:'fr',visitorPreview:()=>opened=true}).find(item=>item.label==='Voir comme visiteur').click();assert.equal(opened,true);
});
test('application commands use fixed routes, bounded zoom and the normal close handler',()=>{
 let level=3,route,closed=false,cancelled=false;
 const menu=applicationMenu({language:'fr',load:value=>route=value,web:{getZoomLevel:()=>level,setZoomLevel:value=>level=value,reload(){}},close:()=>closed=true,cancel:()=>cancelled=true,downloading:true,toggleFullscreen(){}});
 const click=label=>menu.find(item=>item.label===label).click();
 click('Mon compte');assert.equal(route,'/account.html');
 click('Agrandir');assert.equal(level,3);
 level=-2;click('Réduire');assert.equal(level,-2);
 click('Taille normale');assert.equal(level,0);
 click('Annuler le téléchargement');assert.equal(cancelled,true);
 click('Quitter ChartsHub');assert.equal(closed,true);
 assert.equal(menu.some(item=>item.label==='Administration'),false);
});
test('English labels and unavailable cancellation when no download is running',()=>{
 const menu=applicationMenu({language:'en',downloading:false});
 assert.equal(menu.find(item=>item.label==='Cancel download').enabled,false);
 assert.ok(menu.find(item=>item.label==='Edit').submenu.some(item=>item.role==='paste'));
 assert.ok(menu.find(item=>item.label==='Reload'));
});
