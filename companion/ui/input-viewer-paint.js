import{paintAfterglow}from'./input-viewer-trail-paint.js';
import{paintStyleAccent}from'./input-viewer-extra-styles.js';
// Canvas-only artwork: no game capture, external image, or input history.
function outline(ctx, c) {
 ctx.beginPath();
 if (c.shape === 'circle') ctx.ellipse(c.x+c.width/2,c.y+c.height/2,c.width/2,c.height/2,0,0,Math.PI*2);
 else if(c.shape==='star'){for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,r=i%2?.45:1,x=c.x+c.width/2+Math.cos(angle)*c.width/2*r,y=c.y+c.height/2+Math.sin(angle)*c.height/2*r;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.closePath();}
 else if(c.shape==='diamond'){ctx.moveTo(c.x+c.width/2,c.y);ctx.lineTo(c.x+c.width,c.y+c.height/2);ctx.lineTo(c.x+c.width/2,c.y+c.height);ctx.lineTo(c.x,c.y+c.height/2);ctx.closePath();}
 else ctx.roundRect(c.x,c.y,c.width,c.height,Math.min(12,c.height/4));
}
const inset=(c,n)=>({...c,x:c.x+n,y:c.y+n,width:Math.max(1,c.width-2*n),height:Math.max(1,c.height-2*n)});
// Neutral highlights preserve depth while the chosen idle colour tints the
// material. Colours are validated hex values in the model before rendering.
const mix=(hex,target,amount)=>'#'+[0,2,4].map(index=>{
 const a=parseInt(hex.slice(index+1,index+3),16),b=parseInt(target.slice(index+1,index+3),16);
 return Math.round(a+(b-a)*amount).toString(16).padStart(2,'0');
}).join('');
const profiles=Object.freeze({cyberpunk:1,metal:.6,minimal:.24,hologram:.48,arcade:.36,glass:.42,wireframe:.3,energy:1.3});
const styleOf=config=>Object.hasOwn(profiles,config.renderStyle)?config.renderStyle:'cyberpunk';
function name(ctx,c,config,x=c.x+c.width/2,y=c.y+c.height/2){
 if(!config.showNames)return;const label=c.shape==='star'&&c.label==='Star Power'?'SP':c.label;ctx.fillStyle=c.palette?.label||'#f3f8ff';ctx.font='600 '+c.fontSize+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,x,y,Math.max(5,c.width-8));
}
function scanlines(ctx,c,trace){
 ctx.save();trace();ctx.clip();ctx.strokeStyle=c.color;ctx.globalAlpha=.32;ctx.lineWidth=.7;
 const spacing=Math.max(4,c.height*.085);
 for(let y=c.y+spacing;y<c.y+c.height;y+=spacing){ctx.beginPath();ctx.moveTo(c.x,y);ctx.lineTo(c.x+c.width,y);ctx.stroke();}
 ctx.restore();
}
function paintHalo(ctx,c,down,config,trace){
 const bloom=Math.max(0,Math.min(80,config.bloom));if(!bloom)return;
 const style=styleOf(config),strength=profiles[style];
 ctx.save();ctx.strokeStyle=c.color;ctx.shadowColor=c.color;
 if(style==='energy'){
  // One bounded aura per control adds a distinct energy look without storing
  // particles, reading the clock or running another animation loop.
  ctx.save();ctx.translate(c.x+c.width/2,c.y+c.height/2);ctx.scale(c.width*(.6+bloom/200),c.height*(.6+bloom/200));
  const aura=ctx.createRadialGradient(0,0,.12,0,0,1);aura.addColorStop(0,c.color+'b0');aura.addColorStop(.45,c.color+'65');aura.addColorStop(1,c.color+'00');
  ctx.globalAlpha=down?.85:.3;ctx.fillStyle=aura;ctx.beginPath();ctx.ellipse(0,0,1,1,0,0,Math.PI*2);ctx.fill();ctx.restore();
 }
 ctx.lineWidth=down?4:1.8;ctx.globalAlpha=(down?.95:.42)*strength;
 // Two coloured edge lights make the active glow visible against a game
 // background. Idle light is quieter; a zero slider draws no halo at all.
 ctx.shadowBlur=bloom*(down?1:.3)*strength;trace();ctx.stroke();
 ctx.shadowBlur=bloom*(down?.45:.15)*strength;ctx.globalAlpha=(down?.78:.28)*strength;trace();ctx.stroke();
 ctx.restore();
}
export function paintCymbal(ctx,c,down,config){
 const cx=c.x+c.width*.5,cy=c.y+c.height*.39,rx=c.width*.46,ry=c.height*.29;
 const idle=c.palette?.idle||'#9b732e',style=styleOf(config);
 const ellipse=(x,y,xRadius,yRadius)=>{ctx.beginPath();ctx.ellipse(x,y,xRadius,yRadius,0,0,Math.PI*2);};
 ctx.save();
 // The stand is behind the disc and remains inside this editable control's box.
 ctx.lineCap='round';ctx.lineWidth=Math.max(.6,Math.min(3,c.width*.022));
 const stand=ctx.createLinearGradient(cx-c.width*.025,cy,cx+c.width*.025,cy);
 stand.addColorStop(0,'#172334');stand.addColorStop(.5,'#b4bdcb');stand.addColorStop(1,'#27384d');
 ctx.strokeStyle=stand;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx,c.y+c.height*.91);ctx.stroke();
 ctx.strokeStyle='#66778c';ctx.lineWidth=Math.max(.6,Math.min(2,c.height*.028));
 ctx.beginPath();ctx.moveTo(cx-c.width*.13,c.y+c.height*.94);ctx.lineTo(cx,c.y+c.height*.87);ctx.lineTo(cx+c.width*.13,c.y+c.height*.94);ctx.stroke();

 // A thin underside gives the metal disc depth without changing its position
 // on a hit. Light and rim brightness alone indicate the pressed state.
 paintHalo(ctx,c,down,config,()=>ellipse(cx,cy,rx,ry));
 if(['minimal','arcade','hologram','wireframe'].includes(style)){
  ellipse(cx,cy,rx,ry);
  if(style!=='wireframe'){ctx.fillStyle=style==='hologram'?(down?c.color+'70':idle+'55'):(down?mix(idle,c.color,.3):idle);ctx.fill();}
  if(style==='arcade'){ctx.strokeStyle='#040710';ctx.lineWidth=Math.min(6,c.height*.1);ctx.stroke();}
  ctx.strokeStyle=c.color;ctx.lineWidth=style==='arcade'?Math.min(3.4,c.height*.055):(down?2.5:1.5);ctx.stroke();
  if(style==='wireframe'||style==='hologram'){
   ctx.lineWidth=.7;ctx.globalAlpha=.65;
   for(const scale of [.45,.65,.83]){ellipse(cx,cy,rx*scale,ry*scale);ctx.stroke();}ctx.globalAlpha=1;
   if(style==='hologram')scanlines(ctx,c,()=>ellipse(cx,cy,rx,ry));
  }
  ellipse(cx,cy-c.height*.04,c.width*.11,c.height*.13);
  if(style!=='wireframe'){ctx.fillStyle=style==='hologram'?c.color+'40':mix(idle,'#ffffff',.22);ctx.fill();}ctx.lineWidth=1;ctx.stroke();
  ellipse(cx,cy-c.height*.07,c.width*.018,c.height*.022);ctx.fillStyle='#080d14';if(style!=='wireframe')ctx.fill();else ctx.stroke();
  name(ctx,c,config,cx,c.y+c.height*.77);
  ctx.restore();return;
 }
 ellipse(cx,cy+c.height*.045,rx,ry);ctx.fillStyle=mix(idle,'#000000',.55);
 if(style==='glass'){ctx.strokeStyle=c.color+'66';ctx.lineWidth=1;ctx.stroke();}else ctx.fill();
 const metal=ctx.createLinearGradient(c.x,cy-ry,c.x+c.width,cy+ry);
 const material=hex=>style==='glass'?hex+'99':hex;
 metal.addColorStop(0,material(mix(idle,'#ffffff',down?.75:.12)));metal.addColorStop(.22,material(mix(idle,'#ffffff',.64)));
 metal.addColorStop(.43,material(mix(idle,'#ffffff',down?.84:.37)));metal.addColorStop(.58,material(mix(idle,'#000000',.13)));
 metal.addColorStop(.78,material(mix(idle,'#ffffff',.46)));metal.addColorStop(1,material(mix(idle,'#000000',.28)));
 ellipse(cx,cy,rx,ry);ctx.fillStyle=metal;ctx.shadowColor=c.color;
 ctx.shadowBlur=(down?config.bloom:config.bloom*.3)*(style==='metal'?.6:1);ctx.fill();
 ctx.strokeStyle=c.color;ctx.lineWidth=Math.max(.6,Math.min(down?3:1.7,c.height*.04));ctx.stroke();ctx.shadowBlur=0;

 // Fine concentric lathe grooves distinguish a cymbal from an oval button.
 ctx.lineWidth=Math.max(.35,Math.min(.8,c.height*.012));
 for(let ring=3;ring<=11;ring++){
  const scale=ring/12;ellipse(cx,cy,rx*scale,ry*scale);
  ctx.strokeStyle=ring%2?'#ffffff5c':'#00000055';ctx.stroke();
 }
 const shine=ctx.createLinearGradient(cx-rx,cy-ry,cx+rx,cy+ry);
 shine.addColorStop(0,'#ffffff00');shine.addColorStop(.4,style==='glass'?'#ffffff80':(down?'#ffffff55':'#ffffff28'));shine.addColorStop(.6,'#ffffff00');
 ellipse(cx,cy,rx*.94,ry*.94);ctx.fillStyle=shine;ctx.fill();

 // Raised centre bell, mounting washer and dark hole remain recognisable at
 // stream sizes. Their geometry is deterministic and scales with width/height.
 const bellY=cy-c.height*.04,bellRx=c.width*.12,bellRy=c.height*.14;
 const bell=ctx.createLinearGradient(cx-bellRx,bellY-bellRy,cx+bellRx,bellY+bellRy);
 bell.addColorStop(0,mix(idle,'#ffffff',.78));bell.addColorStop(.3,mix(idle,'#ffffff',.55));bell.addColorStop(.75,mix(idle,'#000000',.14));bell.addColorStop(1,mix(idle,'#000000',.55));
 ellipse(cx,bellY,bellRx,bellRy);ctx.fillStyle=bell;ctx.fill();ctx.strokeStyle='#ffffff9e';ctx.lineWidth=Math.max(.4,Math.min(1,c.height*.018));ctx.stroke();
 ellipse(cx,bellY-c.height*.035,c.width*.037,c.height*.039);ctx.fillStyle=mix(idle,'#000000',.73);ctx.fill();
 ellipse(cx,bellY-c.height*.04,c.width*.018,c.height*.022);ctx.fillStyle='#080d14';ctx.fill();
 if(down){ellipse(cx,cy,rx*.98,ry*.98);ctx.strokeStyle=mix(c.color,'#ffffff',.65);ctx.globalAlpha=.8;ctx.lineWidth=Math.max(.5,Math.min(1.2,c.height*.02));ctx.stroke();ctx.globalAlpha=1;}
 if(config.showNames){ctx.fillStyle=c.palette?.label||'#f8fbff';ctx.shadowColor='#000';ctx.shadowBlur=3;ctx.font='600 '+c.fontSize+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(c.label,cx,c.y+c.height*.77,Math.max(5,c.width-8));}
 ctx.restore();
}
function paintBaseControl(ctx,c,down,config){
 if(c.shape==='cymbal'){paintCymbal(ctx,c,down,config);return;}
 const idle=c.palette?.idle||'#101d30',style=styleOf(config);
 ctx.save();
 paintHalo(ctx,c,down,config,()=>outline(ctx,c));
 if(['minimal','arcade','hologram','wireframe'].includes(style)){
  const face=inset(c,style==='arcade'?Math.min(4,c.width/8,c.height/8):1.5);
  outline(ctx,face);
  if(style!=='wireframe'){ctx.fillStyle=style==='hologram'?(down?c.color+'70':idle+'55'):(down?c.color:idle);ctx.fill();}
  if(style==='arcade'){ctx.strokeStyle='#040710';ctx.lineWidth=Math.min(7,c.width*.12,c.height*.12);ctx.stroke();}
  ctx.strokeStyle=c.color;ctx.lineWidth=style==='arcade'?Math.min(4,c.width*.065,c.height*.065):(down?2.5:1.5);ctx.stroke();
  if(style==='hologram')scanlines(ctx,face,()=>outline(ctx,face));
  if(style==='wireframe'){
   outline(ctx,inset(face,Math.min(7,c.width/6,c.height/6)));ctx.globalAlpha=.55;ctx.lineWidth=.7;ctx.stroke();ctx.globalAlpha=1;
  }
  name(ctx,c,config);
  ctx.restore();return;
 }
 // A recessed rim makes idle controls visible without flooding the overlay.
 outline(ctx,c);const rim=ctx.createLinearGradient(0,c.y,0,c.y+c.height);
 const rimColor=hex=>style==='glass'?hex+'55':hex;
 rim.addColorStop(0,rimColor(down?mix(c.color,'#ffffff',style==='metal'?.8:.35):c.color));rim.addColorStop(.3,rimColor(mix(idle,'#ffffff',style==='metal'?.22:.08)));rim.addColorStop(.75,rimColor(mix(idle,'#000000',.45)));rim.addColorStop(1,rimColor(c.color));
 ctx.fillStyle=rim;ctx.shadowColor=c.color;ctx.shadowBlur=(down?config.bloom:config.bloom*.3)*(style==='metal'?.6:1);ctx.fill();
 const inner=inset(c,Math.min(5,c.width/9,c.height/9));outline(ctx,inner);
 const fill=style==='energy'?ctx.createRadialGradient(inner.x+inner.width/2,inner.y+inner.height/2,0,inner.x+inner.width/2,inner.y+inner.height/2,Math.max(inner.width,inner.height)*.7):ctx.createLinearGradient(0,inner.y,0,inner.y+inner.height);
 const material=hex=>style==='glass'?hex+'85':hex;
 fill.addColorStop(0,material(down?c.color:mix(idle,'#ffffff',style==='energy'?.24:.08)));fill.addColorStop(.35,material(down?c.color:idle));fill.addColorStop(1,material(down?mix(c.color,'#000000',.8):mix(idle,'#000000',.62)));
 ctx.fillStyle=fill;ctx.fill();
 ctx.strokeStyle=down?mix(c.color,'#ffffff',.35):c.color;ctx.lineWidth=down?3:1.5;ctx.stroke();ctx.shadowBlur=0;
 outline(ctx,inset(c,Math.min(10,c.width/6,c.height/6)));ctx.strokeStyle=c.color;ctx.globalAlpha=down?.9:.28;ctx.lineWidth=1;ctx.stroke();ctx.globalAlpha=1;
 // A narrow highlight reads well at small stream sizes.
 const shine=ctx.createLinearGradient(0,inner.y,0,inner.y+inner.height*.55);
 shine.addColorStop(0,style==='glass'?'#ffffffa0':style==='metal'?(down?'#ffffff60':'#ffffff30'):(down?'#ffffff28':'#ffffff10'));shine.addColorStop(1,'#ffffff00');
 ctx.fillStyle=shine;outline(ctx,inset(inner,2));ctx.fill();
 if(config.showNames){ctx.shadowColor='#000';ctx.shadowBlur=3;name(ctx,c,config);}
 ctx.restore();
}
const extraBase=Object.freeze({plasma:'energy',crystal:'glass',synthwave:'hologram',industrial:'metal'});
export function paintControl(ctx,c,down,config){const base=extraBase[config.renderStyle];if(!base){paintBaseControl(ctx,c,down,config);return;}paintBaseControl(ctx,c,down,{...config,renderStyle:base});paintStyleAccent(ctx,c,down,config);}
export function paintTrail(ctx,c,ghost,config,trace,now){paintAfterglow(ctx,c,ghost,config,trace,now);}
