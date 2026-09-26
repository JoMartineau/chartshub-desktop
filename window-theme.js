'use strict';
function windowTheme(value){
 if(!value||!['dark','light'].includes(value.mode)||typeof value.accent!=='string'||!/^#[a-f0-9]{6}$/i.test(value.accent))return null;
 const light=value.mode==='light',base=light?[244,247,251]:[9,14,25],accent=value.accent.slice(1).match(/../g).map(v=>parseInt(v,16));
 const color='#'+base.map((v,i)=>Math.round(v*.9+accent[i]*.1).toString(16).padStart(2,'0')).join('');
 return {mode:value.mode,color,accent:value.accent.toLowerCase(),symbolColor:light?'#17263e':'#eef3ff'};
}
module.exports={windowTheme};
