// Bounded, deterministic canvas effects for already-sampled input trails.
// This renderer owns no timer, device access, mutable history or external asset.
const vectors=Object.freeze({up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]});
const clamp=(number,min,max)=>Math.max(min,Math.min(max,number));

function feather(ctx,x,y,rx,ry,color,opacity){
 if(opacity<=0)return;
 ctx.save();ctx.globalAlpha=clamp(opacity,0,1);ctx.translate(x,y);ctx.scale(Math.max(1,rx),Math.max(1,ry));
 const light=ctx.createRadialGradient(0,0,0,0,0,1);
 light.addColorStop(0,color+'c0');light.addColorStop(.3,color+'88');light.addColorStop(.7,color+'28');light.addColorStop(1,color+'00');
 ctx.fillStyle=light;ctx.beginPath();ctx.ellipse(0,0,1,1,0,0,Math.PI*2);ctx.fill();ctx.restore();
}

function ring(ctx,x,y,rx,ry,color,opacity,width){
 ctx.save();ctx.globalAlpha=clamp(opacity,0,1);ctx.strokeStyle=color;ctx.lineWidth=width;
 ctx.beginPath();ctx.ellipse(x,y,Math.max(1,rx),Math.max(1,ry),0,0,Math.PI*2);ctx.stroke();ctx.restore();
}

/** `ghost` supplies movement, thickness and fade from the validated model.
 * Shift its origin to the emitting edge so fresh light is not hidden beneath
 * the opaque control until it has almost completely faded. */
export function paintAfterglow(ctx,c,ghost,config,trace,now){
 const settings=config.trails,direction=c.trailDirection??settings.direction,vector=vectors[direction];
 if(!vector||!ghost||ghost.opacity<=0)return;
 const lifetime=settings.durationMs,elapsed=now-trace.at,age=elapsed/lifetime;
 if(!Number.isFinite(age)||age<0||age>=1)return;
 const opacity=clamp(ghost.opacity,0,1),color=c.palette?.trail??c.color;
 const softness=clamp(config.bloom,0,80)/80;
 const rx=Math.max(1,ghost.width*(.34+softness*.16)),ry=Math.max(1,ghost.height*(.34+softness*.16));
 const [dx,dy]=vector,px=-dy,py=dx;
 const x=ghost.x+ghost.width/2+dx*(c.width/2+rx*.2);
 const y=ghost.y+ghost.height/2+dy*(c.height/2+ry*.2);
 const along=dx?rx:ry,cross=dx?ry:rx;
 const style=settings.style??'soft';

 ctx.save();ctx.shadowBlur=0;ctx.globalCompositeOperation='source-over';
 if(style==='comet'){
  // A soft head and three progressively smaller tail lights remain coloured;
  // no white hotspot obscures the user's chosen trail colour.
  for(let segment=3;segment>=1;segment--){
   const distance=along*.42*segment,scale=1-segment*.18;
   feather(ctx,x-dx*distance,y-dy*distance,rx*scale,ry*scale,color,opacity*.045*(4-segment));
  }
  feather(ctx,x,y,rx*.52,ry*.52,color,opacity*.3);
 }else if(style==='particles'){
  // Fixed seeds give each of three sparks a small fan. Time only determines
  // its position and fade; re-rendering the same frame is pixel-identical.
  const seed=Math.sin(trace.at*.013+c.x*.17+c.y*.07)*43758.5453;
  const phase=seed-Math.floor(seed);
  for(let spark=0;spark<3;spark++){
   const fan=(spark-1)*cross*.75*age;
   const advance=along*(.1+.26*spark)*age;
   const flutter=Math.sin(phase*Math.PI*2+age*5+spark*2)*cross*.12*age;
   const sx=x+dx*advance+px*(fan+flutter),sy=y+dy*advance+py*(fan+flutter);
   const radius=Math.max(1,Math.min(rx,ry)*(.12+.035*spark)*(1-age*.55));
   feather(ctx,sx,sy,radius*2.6,radius*2.6,color,opacity*.3);
   ctx.globalAlpha=opacity*.58;ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(sx,sy,radius,radius,0,0,Math.PI*2);ctx.fill();
  }
 }else if(style==='pulse'){
  // Expanding rings make motion visible even when configured travel is zero.
  const expansion=.32+age*1.15,width=Math.max(.6,Math.min(2.5,Math.min(rx,ry)*.08));
  ring(ctx,x,y,rx*expansion,ry*expansion,color,opacity*.28,width);
  ring(ctx,x,y,rx*(expansion+.15),ry*(expansion+.15),color,opacity*.1,width*1.7);
  feather(ctx,x,y,rx*.3,ry*.3,color,opacity*.07);
 }else if(style==='beam'){
  // Overlapping short segments deliberately form a continuous coloured beam.
  // Its transverse falloff is feathered while its longitudinal edges overlap.
  const segment=Math.max(2,Math.min(24,settings.speedPxPerSecond/30+3));
  const width=dx?segment:rx*1.25,height=dy?segment:ry*1.25;
  const gradient=ctx.createLinearGradient(x-width/2,y-height/2,dx?x-width/2:x+width/2,dy?y-height/2:y+height/2);
  gradient.addColorStop(0,color+'00');gradient.addColorStop(.25,color+'80');gradient.addColorStop(.5,color);gradient.addColorStop(.75,color+'80');gradient.addColorStop(1,color+'00');
  ctx.globalAlpha=opacity*.5;ctx.fillStyle=gradient;ctx.fillRect(x-width/2,y-height/2,width,height);
 }else if(style==='pixel'){
  // Three crisp, aligned squares form a retro tail, without image smoothing or
  // a particle allocation. Their side lengths follow the control thickness.
  const size=Math.max(2,Math.min(12,Math.min(rx,ry)*.38));
  for(let square=2;square>=0;square--){
   const offset=along*.42*square,side=Math.max(1,size*(1-square*.2));
   const sx=Math.round(x-dx*offset-side/2),sy=Math.round(y-dy*offset-side/2);
   ctx.globalAlpha=opacity*(.55-square*.15);ctx.fillStyle=color;ctx.fillRect(sx,sy,side,side);
  }
 }else{
  // The default stays a soft coloured afterglow. Low per-fragment opacity
  // prevents held controls (sampled at 30 Hz) becoming an opaque ribbon.
  feather(ctx,x,y,rx,ry,color,opacity*.16);
 }
 ctx.restore();
}
