'use strict';
function applicationMenu({language,load,web,close,cancel,downloading,toggleFullscreen}){
 const fr=language==='fr',t=(a,b)=>fr?a:b;
 return [
  {label:t('Catalogue','Catalogue'),click:()=>load('/')},
  {label:t('Mon compte','My account'),click:()=>load('/account.html')},
  {type:'separator'},
  {label:t('Édition','Edit'),submenu:[
   {label:t('Annuler','Undo'),role:'undo'},{label:t('Rétablir','Redo'),role:'redo'},
   {type:'separator'},{label:t('Couper','Cut'),role:'cut'},{label:t('Copier','Copy'),role:'copy'},
   {label:t('Coller','Paste'),role:'paste'},{label:t('Tout sélectionner','Select all'),role:'selectAll'}]},
  {label:t('Actualiser','Reload'),click:()=>web.reload()},
  {label:t('Agrandir','Zoom in'),click:()=>web.setZoomLevel(Math.min(3,web.getZoomLevel()+.5))},
  {label:t('Réduire','Zoom out'),click:()=>web.setZoomLevel(Math.max(-2,web.getZoomLevel()-.5))},
  {label:t('Taille normale','Reset zoom'),click:()=>web.setZoomLevel(0)},
  {label:t('Plein écran','Full screen'),click:toggleFullscreen},
  {type:'separator'},
  {label:t('Annuler le téléchargement','Cancel download'),enabled:downloading,click:cancel},
  {label:t('Quitter ChartsHub','Quit ChartsHub'),click:close}
 ];
}
module.exports={applicationMenu};
