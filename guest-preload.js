'use strict';
const {ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://chartshub.ca'){
 window.addEventListener('DOMContentLoaded',()=>{
  const bar=document.createElement('div'),text=document.createElement('span'),button=document.createElement('button');
  Object.assign(bar.style,{position:'sticky',top:'0',zIndex:'10001',display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:'12px',padding:'12px 20px',background:'#15263b',color:'#ffffff',borderBottom:'2px solid #49bbff',font:'14px system-ui'});
  button.type='button';button.className='button button-primary';
  button.addEventListener('click',()=>ipcRenderer.invoke('chartshub:close-guest'));
  const translate=()=>{const fr=document.documentElement.lang.startsWith('fr');text.textContent=fr?'Vue visiteur — sans compte connecté':'Guest view — signed out';button.textContent=fr?'Revenir à Admin':'Return to Admin';};
  translate();new MutationObserver(translate).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  bar.append(text,button);document.body.prepend(bar);
 });
}
