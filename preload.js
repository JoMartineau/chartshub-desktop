'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://chartshub.ca'){
 contextBridge.exposeInMainWorld('ChartsHubDesktop',{
  version:'0.1.6',
  downloadBatch:endpoints=>ipcRenderer.invoke('chartshub:download-batch',endpoints),
  download:endpoint=>ipcRenderer.invoke('chartshub:download',endpoint),
  cancel:()=>ipcRenderer.invoke('chartshub:cancel'),
  onProgress:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_event,data)=>callback(data);ipcRenderer.on('chartshub:progress',listener);return ()=>ipcRenderer.removeListener('chartshub:progress',listener);}
 });
 // Mount in the site's utility bar; retain the focused text field for Edit actions.
 window.addEventListener('DOMContentLoaded',()=>{
  let caption;
  if(process.platform==='win32'){
   caption=document.createElement('div');caption.textContent='ChartsHub';
   const logo=document.createElement('img');logo.src='https://chartshub.ca/assets/icon.svg';logo.alt='';logo.width=16;logo.height=16;logo.style.marginRight='8px';caption.prepend(logo);
   Object.assign(caption.style,{height:'32px',minHeight:'32px',boxSizing:'border-box',padding:'0 150px 0 16px',display:'flex',alignItems:'center',font:'600 12px system-ui',position:'sticky',top:'0',zIndex:'10000',borderBottom:'2px solid',webkitAppRegion:'drag'});
   document.body.prepend(caption);
  }
  let lastMode;
  const syncFrame=()=>{
   const mode=document.documentElement.dataset.theme==='light'?'light':'dark';
   if(mode!==lastMode){lastMode=mode;void ipcRenderer.invoke('chartshub:theme',mode);}
   if(caption){caption.style.background=mode==='light'?'#f4f7fb':'#090e19';caption.style.color=mode==='light'?'#17263e':'#eef3ff';caption.style.borderBottomColor=getComputedStyle(document.documentElement).getPropertyValue('--blue').trim()||'#49bbff';}
  };
  new MutationObserver(syncFrame).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-accent','style']});
  syncFrame();
  const button=document.createElement('button');
  button.type='button';button.className='button button-ghost';button.textContent='Application ▾';
  button.setAttribute('aria-haspopup','menu');
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>ipcRenderer.invoke('chartshub:menu',document.documentElement.lang.startsWith('fr')?'fr':'en'));
  const fallback=document.createElement('div');fallback.className='theme-topbar';fallback.append(button);
  if(caption)caption.after(fallback);else document.body.prepend(fallback);
  const observer=new MutationObserver(()=>{
   const bar=[...document.querySelectorAll('.theme-topbar')].find(el=>el!==fallback);
   if(bar){bar.prepend(button);fallback.remove();if(caption)document.body.prepend(caption);observer.disconnect();}
  });
  observer.observe(document.body,{childList:true,subtree:true});
  const bar=[...document.querySelectorAll('.theme-topbar')].find(el=>el!==fallback);
  if(bar){bar.prepend(button);fallback.remove();if(caption)document.body.prepend(caption);observer.disconnect();}
 });
}
