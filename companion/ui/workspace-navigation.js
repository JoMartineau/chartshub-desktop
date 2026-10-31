/** Companion workspaces retain their existing DOM and live operations. */
export const WORKSPACES=Object.freeze([
 {id:'library',fr:'Bibliothèque',en:'Library',descriptionFr:'Vos morceaux, leurs fichiers et leur état.',descriptionEn:'Your songs, files and library status.'},
 {id:'catalogue',fr:'Catalogue',en:'Catalogue',descriptionFr:'Rechercher, télécharger et retrouver les derniers ajouts.',descriptionEn:'Search, download and find recent additions.'},
 {id:'player',fr:'Lecteur',en:'Player',descriptionFr:'Écouter les morceaux de votre bibliothèque.',descriptionEn:'Listen to songs in your library.'},
 {id:'stream',fr:'Stream / OBS',en:'Stream / OBS',descriptionFr:'Préparer les widgets, profils et sources du stream.',descriptionEn:'Prepare stream widgets, profiles and sources.'},
 {id:'calibration',fr:'Calibration · BETA',en:'Calibration · BETA',descriptionFr:'Préparer le connecteur et comparer vos essais audio et vidéo séparément.',descriptionEn:'Set up the connector and compare audio and video trials separately.'},
 {id:'requests',fr:'Demandes',en:'Requests',descriptionFr:'Recevoir et gérer les demandes des spectateurs.',descriptionEn:'Receive and manage viewer requests.'},
 {id:'status',fr:'État',en:'Status',descriptionFr:'Connexions, bibliothèque, OBS et reprise après un redémarrage.',descriptionEn:'Connections, library, OBS and recovery after a restart.'},
 {id:'settings',fr:'Réglages',en:'Settings',descriptionFr:'Connexions du jeu, apparence, sauvegardes et mises à jour.',descriptionEn:'Game connections, appearance, backups and updates.'}
]);
const sections={library:['#library-panel'],catalogue:['#catalogue-panel','#downloads-panel','.floating-panels-card'],player:['#local-music-player-panel'],stream:['#performance-panel','#profiles-panel','.preview-card','#builder-inspector','.settings-card','.destinations-card','.behavior-note','#stream-panel','.overlay-switch'],calibration:['#calibration-panel'],requests:['#song-requests-panel'],status:['#status-panel'],settings:['#clonehero-source','#game-filters','#simulation-panel','#theme-panel','.theme-widget-section','#updates-panel','#config-backup-panel']};
const key='chartshub:companion-workspace-v1';
export class WorkspaceNavigation{
 constructor(root,{storage,language='fr',gameplayMeasurements=false,calibrationBeta=false}={}){
  this.root=root;this.document=root.ownerDocument;this.window=this.document.defaultView;this.storage=storage;this.language=language;this.active='library';this.nodes=new Map();this.listeners=[];
  gameplayMeasurements=gameplayMeasurements===true;calibrationBeta=gameplayMeasurements&&calibrationBeta===true;
  this.workspaces=WORKSPACES.filter(item=>item.id!=='calibration'||calibrationBeta===true);
  const calibrationPanel=root.querySelector('#calibration-panel');if(calibrationPanel)calibrationPanel.hidden=calibrationBeta!==true;
  const performancePanel=root.querySelector('#performance-panel');if(performancePanel)performancePanel.hidden=!gameplayMeasurements;
  try{this.storage??=this.window.localStorage;const saved=this.storage?.getItem(key);if(this.workspaces.some(item=>item.id===saved))this.active=saved;}catch{}
  for(const [id,selectors]of Object.entries(sections))for(const selector of selectors)for(const node of root.querySelectorAll(selector)){if((selector==='#performance-panel'&&!gameplayMeasurements)||(selector==='#calibration-panel'&&!calibrationBeta)){node.setAttribute('inert','');continue;}let allowed=this.nodes.get(node);if(!allowed){allowed=new Set();this.nodes.set(node,allowed);}allowed.add(id);}
  for(const [node,allowed]of this.nodes)node.dataset.companionWorkspaces=[...allowed].join(' ');
  this.nav=root.querySelector('#companion-workspace-nav');
  for(const button of this.nav?.querySelectorAll('[data-companion-workspace]')||[]){button.hidden=!this.workspaces.some(item=>item.id===button.dataset.companionWorkspace);if(button.hidden)button.setAttribute('inert','');else button.removeAttribute('inert');}
  this.click=event=>{const button=event.target.closest?.('[data-companion-workspace]');if(button&&this.nav?.contains(button))this.select(button.dataset.companionWorkspace,{scroll:true});};
  this.keys=event=>{const button=event.target.closest?.('[data-companion-workspace]');if(!button||button.hidden||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const list=[...this.nav.querySelectorAll('[data-companion-workspace]')].filter(item=>!item.hidden),at=list.indexOf(button);const next=event.key==='Home'?0:event.key==='End'?list.length-1:(at+(event.key==='ArrowRight'?1:list.length-1))%list.length;list[next].focus();this.select(list[next].dataset.companionWorkspace,{scroll:true});};
  this.nav?.addEventListener('click',this.click);this.nav?.addEventListener('keydown',this.keys);
  this.select(this.active);this.update(language);
 }
 select(id,{scroll=false}={}){
  if(!this.workspaces.some(item=>item.id===id))return false;
  this.active=id;this.root.dataset.workspace=id;
  for(const [node,allowed]of this.nodes){const inactive=!allowed.has(id);node.classList.toggle('workspace-inactive',inactive);if(inactive)node.setAttribute('inert','');else node.removeAttribute('inert');}
  const frame=this.root.querySelector('.workspace');if(frame){const active=[...this.nodes].some(([node,allowed])=>frame.contains(node)&&allowed.has(id));frame.classList.toggle('workspace-inactive',!active);}
  for(const button of this.nav?.querySelectorAll('[data-companion-workspace]')||[]){const selected=button.dataset.companionWorkspace===id;button.classList.toggle('is-active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  try{this.storage?.setItem(key,id);}catch{}
  this.update(this.language);
  if(scroll)this.window.scrollTo({top:0,behavior:'instant'});
  this.window.dispatchEvent(new CustomEvent('companion:workspace-change',{detail:{workspace:id}}));
  this.window.requestAnimationFrame?.(()=>this.window.dispatchEvent(new Event('resize')));
  return true;
 }
 reveal(selector){const target=typeof selector==='string'?this.root.querySelector(selector):selector;if(!target||!this.root.contains(target))return false;const entry=[...this.nodes].find(([node])=>node===target||node.contains(target));return entry?this.select([...entry[1]][0]):false;}
 update(language){
  this.language=language==='fr'?'fr':'en';const fr=this.language==='fr',item=WORKSPACES.find(value=>value.id===this.active);
  for(const button of this.nav?.querySelectorAll('[data-companion-workspace]')||[]){const workspace=WORKSPACES.find(value=>value.id===button.dataset.companionWorkspace);if(workspace)button.textContent=fr?workspace.fr:workspace.en;}
  if(this.nav)this.nav.setAttribute('aria-label',fr?'Rubriques du Companion':'Companion workspaces');
  const title=this.root.querySelector('#page-title'),description=this.root.querySelector('.page-heading .subtitle');if(title)title.textContent=fr?item.fr:item.en;if(description)description.textContent=fr?item.descriptionFr:item.descriptionEn;
 }
 dispose(){this.nav?.removeEventListener('click',this.click);this.nav?.removeEventListener('keydown',this.keys);}
}
