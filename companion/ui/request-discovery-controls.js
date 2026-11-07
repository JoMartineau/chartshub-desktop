import { languageCode, languageKey, wordsFor } from './locale-text.js';
const TEXT={
 fr:{title:'Demandes à rechercher',help:'1. Recherchez la chart dans le catalogue. 2. Téléchargez-la dans Songs. 3. Revenez ici, trouvez le morceau installé et confirmez son ajout à la file. Aucun téléchargement ne démarre automatiquement.',empty:'Aucune demande de morceau absent.',search:'Rechercher une chart',matches:'Trouver dans Songs',confirm:'Ajouter à la file',dismiss:'Ignorer',choose:'Choisissez la bonne version…',none:'Aucun morceau installé trouvé. Vérifiez le téléchargement et l’actualisation de la bibliothèque.',failure:'Cette action est indisponible. Vérifiez la réception et la bibliothèque, puis réessayez.',states:{missing:'Absent de Songs',searching:'Recherche ou téléchargement à effectuer',confirming:'Vérification du morceau',queued:'Ajouté à la file'},rules:'Le morceau ne respecte pas les règles des demandes.',busy:'Action en cours…'},
 en:{title:'Requests to find',help:'1. Find the chart in the catalogue. 2. Download it into Songs. 3. Return here, find the installed song and confirm its addition to the queue. Downloads never start automatically.',empty:'No requests for missing songs.',search:'Find a chart',matches:'Find in Songs',confirm:'Add to queue',dismiss:'Dismiss',choose:'Choose the matching version…',none:'No installed song found. Check the download and library refresh.',failure:'This action is unavailable. Check reception and your library, then try again.',states:{missing:'Missing from Songs',searching:'Search or download needed',confirming:'Checking the song',queued:'Added to the queue'},rules:'The song does not meet your request rules.',busy:'Action in progress…'}
};
const HEX=/^[a-f0-9]{64}$/;
export class RequestDiscoveryControls{
 constructor({root,command,onSearch}){
  this.root=root;this.command=command;this.onSearch=onSearch;this.rows=new Map();this.language='fr';this.signature=null;this.disposed=false;
  const d=root.ownerDocument;this.make=(tag,cls='')=>{const n=d.createElement(tag);n.className=cls;return n;};
  this.title=this.make('h3');this.help=this.make('p','helper-text');this.empty=this.make('p','helper-text');this.list=this.make('div','request-discovery-list');
  root.replaceChildren(this.title,this.help,this.empty,this.list);this.update({});
 }
 update(snapshot){
  if(this.disposed)return;const language=languageCode(snapshot?.language),items=Array.isArray(snapshot?.requestDiscovery?.items)?snapshot.requestDiscovery.items.slice(-20):[];
  const signature=JSON.stringify([languageKey(language),items]);if(signature===this.signature)return;this.signature=signature;this.language=language;
  const t=wordsFor(TEXT,language);this.title.textContent=t.title;this.help.textContent=t.help;this.empty.textContent=t.empty;this.empty.hidden=items.length>0;
  const ids=new Set(items.map(item=>item.id));for(const [id,row]of this.rows)if(!ids.has(id)){row.node.remove();this.rows.delete(id);}
  for(const item of items){let row=this.rows.get(item.id);if(!row){row=this.createRow(item);this.rows.set(item.id,row);this.list.append(row.node);}row.item=item;this.renderRow(row);}
 }
 createRow(item){
  const row={item,busy:false,choices:[],selection:'',ticket:0,node:this.make('article','request-discovery-item')};
  row.title=this.make('strong');row.viewer=this.make('p','helper-text');row.state=this.make('p','helper-text');row.actions=this.make('div','request-discovery-actions');
  row.select=this.make('select');row.select.hidden=true;row.select.setAttribute('aria-label','Version');row.feedback=this.make('p','helper-text');row.feedback.setAttribute('role','status');
  row.select.addEventListener('change',()=>{row.selection=row.select.value;this.renderRow(row);});
  for(const action of ['search','matches','confirm','dismiss']){const button=this.make('button','button secondary');button.type='button';button.addEventListener('click',()=>{void this.run(row,action);});row[action]=button;row.actions.append(button);}
  row.node.append(row.title,row.viewer,row.state,row.select,row.actions,row.feedback);return row;
 }
 renderRow(row){
  const t=wordsFor(TEXT,this.language),item=row.item;row.title.textContent=String(item.query??'');row.viewer.textContent=String(item.viewerName??'')+' · '+String(item.platform??'');
  row.state.textContent=t.states[item.state]??t.states.missing;row.select.disabled=row.busy||item.state==='queued';
  if(row.select.children.length)row.select.children[0].textContent=t.choose;
  for(const action of ['search','matches','confirm','dismiss']){row[action].textContent=t[action];row[action].disabled=row.busy||(item.state==='queued'&&action!=='dismiss')||(action==='confirm'&&!HEX.test(row.selection));}
  if(row.error)row.feedback.textContent=t[row.error]??t.failure;else row.feedback.textContent=row.busy?t.busy:'';
 }
 async run(row,action){
  if(this.disposed||row.busy||this.rows.get(row.item.id)!==row||row[action].disabled)return;
  const ticket=++row.ticket;row.busy=true;row.error=null;this.renderRow(row);
  try{
   const suffix={search:'Search',matches:'Matches',confirm:'Confirm',dismiss:'Dismiss'}[action];
   const response=await this.command('songRequests.discovery'+suffix,{id:row.item.id,...(action==='confirm'?{songId:row.selection}:{})});
   if(this.disposed||row.ticket!==ticket||this.rows.get(row.item.id)!==row)return;
   if(response?.ok!==true){row.error=['duration_limit','metadata_unknown','instrument_unavailable','difficulty_unavailable'].includes(response?.code)?'rules':'failure';return;}
   if(action==='search'&&typeof response.result?.query==='string')this.onSearch(response.result.query);
   if(action==='matches'){
    row.choices=Array.isArray(response.result?.items)?response.result.items.filter(item=>HEX.test(item?.id)).slice(0,10):[];row.selection='';
    row.select.replaceChildren();const blank=this.make('option');blank.value='';blank.textContent=wordsFor(TEXT,this.language).choose;row.select.append(blank);
    for(const item of row.choices){const option=this.make('option');option.value=item.id;option.textContent=String(item.artist??'')+' — '+String(item.title??'')+' · '+String(item.charter??'');row.select.append(option);}
    row.select.hidden=!row.choices.length;row.error=row.choices.length?null:'none';
   }
  }catch{if(!this.disposed&&row.ticket===ticket)row.error='failure';}
  finally{if(!this.disposed&&row.ticket===ticket&&this.rows.get(row.item.id)===row){row.busy=false;this.renderRow(row);}}
 }
 dispose(){this.disposed=true;for(const row of this.rows.values())row.ticket++;this.rows.clear();}
}
