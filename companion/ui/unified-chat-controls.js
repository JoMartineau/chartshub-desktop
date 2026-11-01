const TEXT={
 fr:{title:'Chat multistream',help:'Connectez vos comptes, puis activez la lecture du chat. Les messages restent dans cette session. L’affichage dans OBS se choisit séparément dans Stream / OBS.',enabled:'Afficher le chat ici',accounts:'Configurer les comptes',clear:'Effacer les messages locaux',pause:'Mettre l’affichage en pause',resume:'Reprendre l’affichage',all:'Toutes les plateformes',empty:'Aucun message reçu.',off:'Lecture du chat arrêtée',failure:'Le chat n’a pas pu appliquer cette action.',states:{connected:'Connecté',connecting:'Connexion…',disconnected:'Non connecté',authorizing:'Autorisation en cours',awaiting_authorization:'Autorisation en cours',not_configured:'Configuration éditeur nécessaire',error:'Connexion à vérifier'},kick:'Kick : le relais officiel doit être configuré avant la connexion.'},
 en:{title:'Multistream chat',help:'Connect your accounts, then enable chat reading. Messages stay in this session. Sharing them in OBS is a separate choice in Stream / OBS.',enabled:'Show chat here',accounts:'Set up accounts',clear:'Clear local messages',pause:'Pause display',resume:'Resume display',all:'All platforms',empty:'No messages received.',off:'Chat reading stopped',failure:'Chat could not apply this action.',states:{connected:'Connected',connecting:'Connecting…',disconnected:'Not connected',authorizing:'Waiting for authorisation',awaiting_authorization:'Waiting for authorisation',not_configured:'Publisher setup required',error:'Check connection'},kick:'Kick: the official relay must be configured before connecting.'}
};
export class UnifiedChatControls{
 constructor({root,command,onAccounts}){
  this.root=root;this.command=command;this.onAccounts=onAccounts;this.language='fr';this.snapshot=null;this.signature=null;this.rows=new Map();this.paused=false;this.frozenMessages=[];this.filter='all';this.ticket=0;this.disposed=false;
  const d=root.ownerDocument;this.make=(tag,cls='')=>{const n=d.createElement(tag);n.className=cls;return n;};
  this.title=this.make('h2');this.help=this.make('p','helper-text');this.label=this.make('label');this.enabled=this.make('input');this.enabled.type='checkbox';this.caption=this.make('span');this.label.append(this.enabled,this.caption);
  this.platforms=this.make('div','unified-chat-platforms');this.platformNodes={};for(const platform of ['twitch','tiktok','kick']){const n=this.make('span','status-pill');this.platformNodes[platform]=n;this.platforms.append(n);}
  this.actions=this.make('div','unified-chat-actions');this.accounts=this.make('button','button secondary');this.accounts.type='button';this.clear=this.make('button','button secondary');this.clear.type='button';this.pause=this.make('button','button secondary');this.pause.type='button';this.source=this.make('select');this.source.setAttribute('aria-label','Plateforme / Platform');
  for(const value of ['all','twitch','tiktok','kick']){const option=this.make('option');option.value=value;option.textContent=value;this.source.append(option);}this.source.value='all';this.actions.append(this.accounts,this.clear,this.pause,this.source);
  this.note=this.make('p','helper-text');this.feedback=this.make('p','helper-text');this.feedback.setAttribute('role','status');this.empty=this.make('p','helper-text');this.list=this.make('div','unified-chat-messages');this.list.setAttribute('role','log');this.list.setAttribute('aria-live','polite');
  root.replaceChildren(this.title,this.help,this.label,this.platforms,this.actions,this.note,this.feedback,this.empty,this.list);
  this.enabled.addEventListener('change',()=>{void this.run('configure',{enabled:this.enabled.checked});});
  this.accounts.addEventListener('click',()=>{if(!this.disposed)this.onAccounts();});this.clear.addEventListener('click',()=>{void this.run('clear',{});});
  this.pause.addEventListener('click',()=>{this.paused=!this.paused;if(this.paused)this.frozenMessages=(this.snapshot?.chat?.messages??[]).slice(-100);this.signature=null;this.update(this.snapshot);});
  this.source.addEventListener('change',()=>{this.filter=['twitch','tiktok','kick'].includes(this.source.value)?this.source.value:'all';this.signature=null;this.update(this.snapshot);});this.update({});
 }
 update(snapshot){
  if(this.disposed)return;this.snapshot=snapshot;const state=snapshot?.chat??{},language=snapshot?.language==='en'?'en':'fr';
  const signature=JSON.stringify([state,language,this.paused,this.filter,this.error]);if(signature===this.signature)return;this.signature=signature;this.language=language;
  const t=TEXT[language];this.title.textContent=t.title;this.help.textContent=t.help;this.caption.textContent=t.enabled;this.enabled.checked=state.enabled===true;
  this.accounts.textContent=t.accounts;this.clear.textContent=t.clear;this.pause.textContent=this.paused?t.resume:t.pause;this.source.children[0].textContent=t.all;
  this.feedback.textContent=this.error?t.failure:'';this.note.textContent=t.kick;
  for(const p of ['twitch','tiktok','kick']){const label=p==='tiktok'?'TikTok LIVE':p==='twitch'?'Twitch':'Kick';this.platformNodes[p].textContent=label+' · '+(t.states[state.connections?.[p]?.state]??t.states.disconnected);}
  if(!state.enabled){this.frozenMessages=[];this.list.replaceChildren();this.rows.clear();this.empty.hidden=false;this.empty.textContent=t.off;return;}
  if(this.paused){const liveIds=new Set((state.messages??[]).map(item=>item.id));this.frozenMessages=this.frozenMessages.filter(item=>liveIds.has(item.id)&&state.connections?.[item.platform]?.state==='connected');}
  const source=this.paused?this.frozenMessages:state.messages;
  const messages=Array.isArray(source)?source.filter(m=>this.filter==='all'||m.platform===this.filter).slice(-100):[];
  const ids=new Set(messages.map(m=>m.id));for(const[id,row]of this.rows)if(!ids.has(id)){row.node.remove();this.rows.delete(id);}
  const nearBottom=this.list.scrollHeight-this.list.scrollTop-this.list.clientHeight<60;
  for(const m of messages){let row=this.rows.get(m.id);if(!row){const node=this.make('article','unified-chat-message'),header=this.make('div','unified-chat-message-heading'),platform=this.make('span','unified-chat-badge'),name=this.make('strong'),time=this.make('time'),text=this.make('p');header.append(platform,name,time);node.append(header,text);row={node,platform,name,time,text};this.rows.set(m.id,row);this.list.append(node);}
   const contentSignature=JSON.stringify([m.platform,m.name,m.text,m.at,language]);if(row.signature!==contentSignature){row.signature=contentSignature;
    row.platform.textContent=m.platform==='tiktok'?'TikTok':m.platform==='twitch'?'Twitch':'Kick';row.platform.dataset.platform=String(m.platform??'');row.name.textContent=String(m.name??'');row.text.textContent=String(m.text??'');
    row.time.textContent=Number.isSafeInteger(m.at)?new Date(m.at).toLocaleTimeString(language==='fr'?'fr-CA':'en-CA',{hour:'2-digit',minute:'2-digit'}):'';
   }
  }
  this.empty.hidden=messages.length>0;this.empty.textContent=t.empty;if(nearBottom)this.list.scrollTop=this.list.scrollHeight;
 }
 async run(action,payload){
  if(this.disposed)return;const ticket=++this.ticket;this.error=false;
  try{const result=await this.command('chat.'+action,payload);if(!this.disposed&&ticket===this.ticket){this.error=result?.ok!==true;if(action==='clear'&&result?.ok===true){this.frozenMessages=[];this.list.replaceChildren();this.rows.clear();}}}
  catch{if(!this.disposed&&ticket===this.ticket)this.error=true;}
  finally{if(!this.disposed&&ticket===this.ticket){this.signature=null;this.update(this.snapshot);}}
 }
 dispose(){this.disposed=true;this.ticket++;this.rows.clear();}
}
