'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://chartshub.ca'){
 const tabbed=process.argv.includes('--chartshub-tabbed');
 contextBridge.exposeInMainWorld('ChartsHubDesktop',{
  version:'0.14.10',
  layout:tabbed?'tabbed':'legacy',
  saveCheckerReport:payload=>ipcRenderer.invoke('chartshub:save-checker-report',payload),
  downloadState:()=>ipcRenderer.invoke('chartshub:download-state'),
  onDownloadState:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_event,data)=>callback(data);ipcRenderer.on('chartshub:download-state',listener);return ()=>ipcRenderer.removeListener('chartshub:download-state',listener);},
  downloadBatch:endpoints=>ipcRenderer.invoke('chartshub:download-batch',endpoints),
  downloadFolder:change=>ipcRenderer.invoke('chartshub:folder',change===true),
  download:endpoint=>ipcRenderer.invoke('chartshub:download',endpoint),
  cancel:()=>ipcRenderer.invoke('chartshub:cancel'),
  language:value=>ipcRenderer.invoke('chartshub:language',value),
  onProgress:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_event,data)=>callback(data);ipcRenderer.on('chartshub:progress',listener);return ()=>ipcRenderer.removeListener('chartshub:progress',listener);}
 });
 // Mount in the site's utility bar; retain the focused text field for Edit actions.
 window.addEventListener('DOMContentLoaded',()=>{
  window.addEventListener('chartshub:accountchange',()=>ipcRenderer.invoke('chartshub:account-changed'));
  let lastLanguage='';
  const syncLanguage=()=>{const value=document.documentElement.lang.startsWith('fr')?'fr':'en';if(value===lastLanguage)return;lastLanguage=value;void ipcRenderer.invoke('chartshub:language',value);};
  window.addEventListener('chartshub:languagechange',syncLanguage);
  new MutationObserver(syncLanguage).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  syncLanguage();
  let caption;
  if(!tabbed){
   caption=document.createElement('div');caption.textContent='ChartsHub';
   const logo=document.createElement('img');logo.src='https://chartshub.ca/assets/icon.svg';logo.alt='';logo.width=16;logo.height=16;logo.style.marginRight='8px';caption.prepend(logo);
   Object.assign(caption.style,{height:'36px',minHeight:'36px',boxSizing:'border-box',padding:process.platform==='darwin'?'0 16px 0 90px':'0 150px 0 16px',display:'flex',alignItems:'center',font:'600 12px system-ui',position:'sticky',top:'0',zIndex:'10000',borderBottom:'1px solid',webkitAppRegion:'drag'});
   document.body.prepend(caption);
  }
  const outline=document.createElement('div');outline.setAttribute('aria-hidden','true');
  Object.assign(outline.style,{position:'fixed',inset:'0',border:'1px solid',boxSizing:'border-box',pointerEvents:'none',zIndex:'2147483647'});if(!tabbed)document.body.append(outline);
  let lastTheme='',revision=0;
  const syncFrame=async()=>{
   const mode=document.documentElement.dataset.theme==='light'?'light':'dark';
   const raw=getComputedStyle(document.documentElement).getPropertyValue('--blue').trim();
   const accent=/^#[a-f0-9]{6}$/i.test(raw)?raw:'#4ebcff';
   const key=mode+accent;if(key===lastTheme)return;lastTheme=key;const current=++revision;
   try{const theme=await ipcRenderer.invoke('chartshub:theme',{mode,accent});if(!theme||current!==revision)return;
    if(caption){caption.style.background=theme.color;caption.style.color=theme.symbolColor;caption.style.borderBottomColor=theme.accent;}outline.style.borderColor=theme.accent;
   }catch{lastTheme='';}
  };
  new MutationObserver(syncFrame).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-accent','style']});
  syncFrame();
  const button=document.createElement('button');
  button.type='button';button.className='button button-ghost';button.textContent='Application ▾';
  button.setAttribute('aria-haspopup','menu');
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>ipcRenderer.invoke('chartshub:menu',document.documentElement.lang.startsWith('fr')?'fr':'en'));
  const fullscreen=document.createElement('button');fullscreen.type='button';fullscreen.className='button button-ghost';
  let isFullscreen=false;
  const labelFullscreen=()=>{const fr=document.documentElement.lang.startsWith('fr');fullscreen.textContent=isFullscreen?(fr?'Quitter le plein écran':'Exit full screen'):(fr?'Plein écran':'Full screen');fullscreen.setAttribute('aria-pressed',String(isFullscreen));fullscreen.title='F11 · Esc';};
  fullscreen.onclick=()=>ipcRenderer.invoke('chartshub:fullscreen',true);
  ipcRenderer.on('chartshub:fullscreen-state',(_event,state)=>{isFullscreen=state;labelFullscreen();});
  ipcRenderer.invoke('chartshub:fullscreen',false).then(state=>{isFullscreen=!!state;labelFullscreen();});
  new MutationObserver(labelFullscreen).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});labelFullscreen();
  const fallback=document.createElement('div');fallback.className='theme-topbar';fallback.append(button,fullscreen);
  if(caption)caption.after(fallback);else document.body.prepend(fallback);
  const observer=new MutationObserver(()=>{
   const bar=[...document.querySelectorAll('.theme-topbar')].find(el=>el!==fallback);
   if(bar){bar.prepend(button,fullscreen);fallback.remove();if(caption)document.body.prepend(caption);observer.disconnect();}
  });
  observer.observe(document.body,{childList:true,subtree:true});
  const bar=[...document.querySelectorAll('.theme-topbar')].find(el=>el!==fallback);
  if(bar){bar.prepend(button,fullscreen);fallback.remove();if(caption)document.body.prepend(caption);observer.disconnect();}
 });
}
