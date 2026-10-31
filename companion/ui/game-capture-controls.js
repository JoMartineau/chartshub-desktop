export class GameCaptureControls {
  constructor({root,command}) {
    this.root=root; this.command=command; this.snapshot=null; this.abort=new AbortController();
    this.heading=document.createElement('h3'); this.description=document.createElement('p'); this.description.className='helper-text';
    this.button=document.createElement('button'); this.button.type='button'; this.button.className='button secondary';
    this.feedback=document.createElement('p'); this.feedback.className='helper-text'; this.feedback.setAttribute('role','status');
    root.append(this.heading,this.description,this.button,this.feedback);
    this.button.addEventListener('click',async()=>{this.button.disabled=true;try{const result=await command('gameCapture.open');if(!result?.ok)throw Error();}catch{this.feedback.textContent=this.tr('La capture est indisponible.','Capture is unavailable.');}finally{this.update(this.snapshot);}},{signal:this.abort.signal});
    this.update(null);
  }
  tr(fr,en){return this.snapshot?.language==='en'?en:fr;}
  update(snapshot){this.snapshot=snapshot;this.heading.textContent=this.tr('Highway, score et paroles — capture du jeu','Highway, score and lyrics — game capture');this.description.textContent=this.tr('Choisissez la fenêtre Clone Hero, puis tracez la highway, le score ou les paroles pour des sources OBS séparées. Les paroles sont capturées telles qu’elles apparaissent dans le jeu, avec leur fond ; aucun connecteur ni horloge n’est nécessaire.','Choose the Clone Hero window, then draw highway, score or lyrics regions for separate OBS sources. Lyrics are captured as displayed in the game, including their background; no connector or clock is required.');this.button.textContent=this.tr('Choisir la fenêtre et les zones','Choose window and regions');this.button.disabled=snapshot?.gameCapture?.available!==true;}
  dispose(){this.abort.abort();}
}
