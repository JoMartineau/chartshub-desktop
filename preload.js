'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://chartshub.ca'){
 const tabbed=process.argv.includes('--chartshub-tabbed');
 contextBridge.exposeInMainWorld('ChartsHubDesktop',{
 version:'0.14.32',
  layout:tabbed?'tabbed':'legacy',
  saveCheckerReport:payload=>ipcRenderer.invoke('chartshub:save-checker-report',payload),
  downloadState:()=>ipcRenderer.invoke('chartshub:download-state'),
  onDownloadState:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_event,data)=>callback(data);ipcRenderer.on('chartshub:download-state',listener);return ()=>ipcRenderer.removeListener('chartshub:download-state',listener);},
  downloadBatch:endpoints=>ipcRenderer.invoke('chartshub:download-batch',endpoints),
  downloadFolder:change=>ipcRenderer.invoke('chartshub:folder',change===true),
  download:endpoint=>ipcRenderer.invoke('chartshub:download',endpoint),
  downloadEnchor:request=>ipcRenderer.invoke('chartshub:download-enchor',request),
  enchorDownloadFormats:['folder','zip','sng'],
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
  // Read resolved, bounded colors from the verified page. Never relay CSS text,
  // event payloads, URLs or account data into the native interface.
  const hex=value=>{
   if(typeof value!=='string')return null;const raw=value.trim();
   if(/^#[a-f\d]{6}$/i.test(raw))return raw.toLowerCase();
   if(/^#[a-f\d]{3}$/i.test(raw))return '#'+[...raw.slice(1)].map(c=>c+c).join('').toLowerCase();
   const m=/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(raw);
   return m&&m.slice(1).every(v=>Number(v)<=255)?'#'+m.slice(1).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):null;
  };
  let confirmedTheme='',pendingTheme='',revision=0,framePending=false,syncQueued=false,suspended=false,disposed=false;
  let retryTimer=null,retryAttempt=0,retryKey='';
  const stopRetry=()=>{if(retryTimer!==null){clearTimeout(retryTimer);retryTimer=null;}};
  const retryFrame=()=>{
   if(disposed||suspended||retryTimer!==null||retryAttempt>=6)return;
   retryTimer=setTimeout(()=>{retryTimer=null;scheduleFrame();},[100,250,500,1000,2000,5000][retryAttempt++]);
  };
  const syncFrame=async()=>{
   if(disposed||suspended)return;
   if(pendingTheme){syncQueued=true;return;}
   const root=document.documentElement,mode=root.dataset.theme==='light'?'light':'dark',css=getComputedStyle(root);
   const read=(name,fallback)=>hex(css.getPropertyValue(name))||fallback;
   const paletteMode=root.dataset.chBloomFollowSeason==='false'?'custom':'season';
   const seasonal=paletteMode==='season'&&root.hasAttribute('data-ch-seasonal');
   const colors={accent:read(seasonal?'--ch-season-a':'--blue','#4ebcff'),secondary:read(seasonal?'--ch-season-b':'--purple','#aa88ff'),
    background:read('--bg',mode==='light'?'#f4f7fb':'#080e1a'),surface:read('--panel',mode==='light'?'#ffffff':'#111c2e'),surfaceAlt:read('--panel2',mode==='light'?'#edf2f7':'#18263c'),
    text:read('--white',mode==='light'?'#17263e':'#eef4ff'),muted:read('--muted',mode==='light'?'#5d6f84':'#9db2d0'),border:read('--line',mode==='light'?'#d7e0e9':'#2d4059'),bloom:read('--ch-bloom-color',read(seasonal?'--ch-season-a':'--blue','#a855f7'))};
   const payload={mode,paletteMode,colors},key=JSON.stringify(payload);
   if(key===confirmedTheme){stopRetry();retryAttempt=0;return;}
   if(key!==retryKey){retryKey=key;retryAttempt=0;stopRetry();}
   pendingTheme=key;const current=revision;let accepted=false;
   try{const theme=await ipcRenderer.invoke('chartshub:ui-palette',payload);if(!theme||disposed||suspended||current!==revision)return;
    confirmedTheme=key;accepted=true;stopRetry();retryAttempt=0;
    if(caption){caption.style.background=theme.color;caption.style.color=theme.symbolColor;caption.style.borderBottomColor=theme.accent;}outline.style.borderColor=theme.accent;
   }catch{/* Temporary native unavailability keeps this palette unconfirmed. */}
   finally{
    pendingTheme='';
    if(!disposed&&!suspended){if(accepted||syncQueued||current!==revision){syncQueued=false;scheduleFrame();}else retryFrame();}
   }
  };
  // Native tabs can suspend animation frames while the Catalogue is hidden.
  const scheduleFrame=()=>{if(disposed||suspended||framePending)return;framePending=true;queueMicrotask(()=>{framePending=false;void syncFrame();});};
  const resumeFrame=()=>{if(disposed)return;suspended=false;retryAttempt=0;stopRetry();scheduleFrame();};
  const paletteObserver=new MutationObserver(scheduleFrame);
  paletteObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-accent','style','data-ch-seasonal','data-ch-bloom-follow-season']});
  const stylesheetLoaded=event=>{if(event.target?.tagName==='LINK')scheduleFrame();};
  const visibilityChanged=()=>{if(!document.hidden)resumeFrame();};
  const hideFrame=event=>{
   suspended=true;revision++;stopRetry();
   if(!event.persisted){
    disposed=true;paletteObserver.disconnect();ipcRenderer.removeListener('chartshub:ui-palette-resume',resumeFrame);
    document.removeEventListener('load',stylesheetLoaded,true);document.removeEventListener('visibilitychange',visibilityChanged);
    window.removeEventListener('load',scheduleFrame);window.removeEventListener('pageshow',resumeFrame);window.removeEventListener('pagehide',hideFrame);
   }
  };
  document.addEventListener('load',stylesheetLoaded,true);document.addEventListener('visibilitychange',visibilityChanged);
  window.addEventListener('load',scheduleFrame);window.addEventListener('pageshow',resumeFrame);window.addEventListener('pagehide',hideFrame);
  ipcRenderer.on('chartshub:ui-palette-resume',resumeFrame);
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
