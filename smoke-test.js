const {app,BrowserWindow,session}=require('electron');
const path=require('node:path');
app.whenReady().then(async()=>{
 let win;
 try{
  const ses=session.fromPartition('desktop-smoke');
  await ses.protocol.handle('https',()=>new Response('<!doctype html><title>Test</title>'));
  win=new BrowserWindow({show:false,webPreferences:{session:ses,preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL('https://chartshub.ca/');
  const result=await win.webContents.executeJavaScript('({bridge:typeof window.ChartsHubDesktop?.download,node:typeof window.require})');
  if(result.bridge!=='function'||result.node!=='undefined')throw Error(JSON.stringify(result));
  await win.loadURL('https://example.org/');
  if(await win.webContents.executeJavaScript('typeof window.ChartsHubDesktop')!=='undefined')throw Error('Bridge exposed to external origin');
  console.log('PASS: sandboxed preload, trusted origin only, no renderer Node access');
  win.destroy();app.exit(0);
 }catch(error){console.error(error);win?.destroy();app.exit(1);}
});
