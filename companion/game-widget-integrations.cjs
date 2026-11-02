'use strict';
const {publicTelemetrySnapshot}=require('./clonehero-telemetry-view.cjs');
const failure=code=>Object.assign(Error(code),{code});
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const statuses=new Set(['disabled','waiting','connecting','connected','unsupported','stale','error']);
const reasons=new Set(['PROVIDER_NOT_RUNNING','PROVIDER_DISCONNECTED','UNVALIDATED_GAME_BUILD','PLATFORM_NOT_VALIDATED','INVALID_CONNECTION_DESCRIPTOR','INVALID_TELEMETRY','PROVIDER_STALE','HANDSHAKE_TIMEOUT','GAME_WIDGETS_FAILED']);
function createGameWidgetIntegrations({telemetry,getContext,onChange=()=>{},platform=process.platform}={}){
  if(!telemetry||['snapshot','start','stop','setEnabled'].some(k=>typeof telemetry[k]!=='function')||typeof getContext!=='function'||typeof onChange!=='function')throw failure('GAME_WIDGETS_INVALID');
  // No preference is an opt-in. No source method or filesystem is touched by
  // construction; each Host session starts with both integrations disabled.
  let accuracy=false,lyrics=false,inputViewer=false,revision=0,intent=0,busy=false,disposed=false,scope,active=false,fault=null,notifying=false;
  function context(){try{const c=getContext();if(!record(c)||typeof c.active!=='boolean'||!(Number.isSafeInteger(c.lifecycle)&&c.lifecycle>=0||typeof c.lifecycle==='string'&&c.lifecycle.length<=128))return{active:false,lifecycle:null};return{active:c.active,lifecycle:c.lifecycle};}catch{return{active:false,lifecycle:null};}}
  function raw(){try{return telemetry.snapshot();}catch{return null;}}
  function view(){const enabled=active&&!disposed&&(accuracy||lyrics||inputViewer),s=enabled?raw():null;return{revision,accuracy,lyrics,inputViewer,enabled,supported:platform==='win32',connected:enabled&&s?.enabled===true&&s?.connected===true&&s?.status==='connected',status:fault?'error':!enabled?'disabled':statuses.has(s?.status)?s.status:'waiting',reason:fault??(!enabled?null:reasons.has(s?.reason)?s.reason:null),busy};}
  function notify(){if(disposed||notifying)return;notifying=true;try{onChange(view());}catch{/* Observers never own the opt-in lifecycle. */}finally{notifying=false;}}
  function stopSource(){try{telemetry.stop();}catch{}try{Promise.resolve(telemetry.setEnabled(false)).catch(()=>{});}catch{}}
  function revoke(){const hadWork=accuracy||lyrics||inputViewer||busy;accuracy=lyrics=inputViewer=busy=false;fault=null;++intent;if(hadWork){++revision;stopSource();}return hadWork;}
  function update(){if(disposed)return view();const c=context(),changed=scope!==undefined&&scope!==c.lifecycle,wasActive=active;scope=c.lifecycle;active=c.active;if(changed||!active){if(revoke()||wasActive!==active||changed)notify();}return view();}
  function current(owner){update();return !disposed&&active&&intent===owner;}
  function status(){update();return view();}
  async function configure(value){
    if(!only(value,['revision','accuracy','lyrics'])||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.accuracy!=='boolean'||typeof value.lyrics!=='boolean')throw failure('GAME_WIDGETS_INVALID');
    update();if(disposed)throw failure('GAME_WIDGETS_CANCELLED');if(value.revision!==revision)throw failure('GAME_WIDGETS_STALE');
    return apply({accuracy:value.accuracy,lyrics:value.lyrics,inputViewer});
  }
  // Main-only lease for start/end cues. Renderer configuration remains strictly
  // the paired Accuracy/Lyrics contract; no extra measurements are exposed.
  async function setInputViewerEnabled(enabled){
    if(typeof enabled!=='boolean')throw failure('GAME_WIDGETS_INVALID');update();if(disposed)throw failure('GAME_WIDGETS_CANCELLED');
    return apply({accuracy,lyrics,inputViewer:enabled});
  }
  async function apply(value){
    if(!active)throw failure('GAME_WIDGETS_INACTIVE');if(platform!=='win32'&&(value.accuracy||value.lyrics||value.inputViewer))throw failure('GAME_WIDGETS_UNAVAILABLE');
    if(value.accuracy===accuracy&&value.lyrics===lyrics&&value.inputViewer===inputViewer)return status();
    const wasEnabled=accuracy||lyrics||inputViewer,wasBusy=busy;accuracy=value.accuracy;lyrics=value.lyrics;inputViewer=value.inputViewer;fault=null;const enabled=accuracy||lyrics||inputViewer,owner=++intent;++revision;
    // Switching one integration while the other remains enabled reuses the
    // connection and never resets its measurements or musical clock.
    if(enabled&&wasEnabled&&!wasBusy){busy=false;notify();return status();}
    busy=true;if(!enabled)stopSource();notify();
    if(!current(owner))throw failure('GAME_WIDGETS_CANCELLED');
    try{
      await telemetry.setEnabled(enabled);
      if(!current(owner)){if(!accuracy&&!lyrics&&!inputViewer)stopSource();throw failure('GAME_WIDGETS_CANCELLED');}
      if(enabled)telemetry.start();
      if(!current(owner)){if(!accuracy&&!lyrics&&!inputViewer)stopSource();throw failure('GAME_WIDGETS_CANCELLED');}
      busy=false;notify();return status();
    }catch(error){
      if(intent!==owner||disposed||!active){if(!accuracy&&!lyrics&&!inputViewer)stopSource();throw failure('GAME_WIDGETS_CANCELLED');}
      accuracy=lyrics=inputViewer=busy=false;fault='GAME_WIDGETS_FAILED';++revision;++intent;stopSource();notify();throw failure('GAME_WIDGETS_FAILED');
    }
  }
  function readings(){
    const s=status();if(!s.enabled||!accuracy&&!lyrics)return null;const value=raw();if(!value)return null;
    const caps={...value.capabilities};for(const key of Object.keys(caps))caps[key]=false;
    caps.hitTiming=accuracy&&value.capabilities?.hitTiming===true;caps.clock=lyrics&&value.capabilities?.clock===true;caps.songMetadata=(accuracy||lyrics)&&value.capabilities?.songMetadata===true;
    const safe=publicTelemetrySnapshot({...value,connected:s.connected,status:s.status,capabilities:caps});
    // Only the two requested data groups leave this controller. The existing
    // public shape is retained for stateView, without records or trial data.
    // Safe song labels remain available for either opt-in so real measurements
    // cannot inherit demonstration labels. Musical clock is Lyrics-only.
    if(safe.active){if(!lyrics)safe.active.clock=null;safe.active.stats={score:null,combo:null,misses:null,overstrums:null,notesHit:null,notesTotal:null};}
    safe.hasChartIdentity=false;safe.history=[];safe.comparison={bestScore:null,personalBestScore:null,currentScore:null,delta:null,bestAttempt:null};safe.session={completedSongs:0,fullCombos:0,bestCombo:0,durationSeconds:0};safe.goal={kind:'songs',target:10,value:0,percent:0};return safe;
  }
  function stop(){if(disposed)return;const hadWork=revoke();if(!hadWork)++revision;notify();}
  function dispose(){if(disposed)return;revoke();disposed=true;}
  return{status,configure,setInputViewerEnabled,update,stop,dispose,readings};
}
module.exports={createGameWidgetIntegrations};
