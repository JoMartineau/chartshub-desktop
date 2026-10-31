import type { AppState } from '../../../core/state/AppState.js';
import type { WidgetDefinition, WidgetInstance } from '../../../core/types/Widget.js';
import type { GameplayTelemetry } from '../../../core/types/GameplayTelemetry.js';
import type { SettingsDocument } from '../../../storage/SettingsRepository.js';
import { createDefaultStream } from '../../../overlay/stream/StreamConfig.js';
import type { WidgetComponent, WidgetContent } from '../../engine/WidgetRegistry.js';
import { validateAccuracyConfig, type AccuracyConfig } from './AccuracyConfig.js';
import { validateLyricsConfig } from './LyricsConfig.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const language = (p: GameplayTelemetry) => p.language === 'en' ? 'en' : 'fr';
const label = (p: GameplayTelemetry, fr: string, en: string) => language(p) === 'fr' ? fr : en;
const format = (p: GameplayTelemetry, value: number | null | undefined, decimals = 0) => finite(value) ? new Intl.NumberFormat(language(p), {minimumFractionDigits: decimals, maximumFractionDigits: decimals}).format(value) : '—';
const ms = (p: GameplayTelemetry, value: number | null | undefined, signed = false) => finite(value) ? `${signed && value > 0 ? '+' : ''}${format(p, value, 1)} ms` : '—';
const time = (value: number) => { const n = Math.max(0, Math.floor(value)); return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n % 3600 / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2,'0')}`; };
const content = (lines: string[]): WidgetContent => ({text: lines.join(' · '), lines});
function accuracy(p: GameplayTelemetry, config: AccuracyConfig): WidgetContent {
  const coverage = p.timing.coverage==='complete' ? label(p,'Mesures depuis le début de l’essai','Measured from the start of this attempt') : p.timing.coverage==='since-connect' ? label(p,'Mesures depuis la connexion','Measured since connection') : label(p,'Mesures partielles : interruption détectée','Partial measurements: interruption detected');
  const rows = {
    lastOffsetMs: `${label(p,'Dernier','Last')}: ${ms(p,p.timing.lastOffsetMs,true)}`,
    meanOffsetMs: `${label(p,'Moyenne','Mean')}: ${ms(p,p.timing.meanOffsetMs,true)}`,
    meanAbsoluteOffsetMs: `${label(p,'Écart absolu moyen','Mean absolute offset')}: ${ms(p,p.timing.meanAbsoluteOffsetMs)}`,
    standardDeviationMs: `${label(p,'Dispersion','Deviation')}: ${ms(p,p.timing.standardDeviationMs)}`,
    withinWindowPercent: `±${p.timing.windowMs} ms: ${format(p,p.timing.withinWindowPercent,1)} %`,
    sampleCount: `${format(p,p.timing.sampleCount)} ${label(p,'jugements','judgments')}`
  };
  // Preserve the familiar compact six-line default; a chosen subset gets one row per value.
  const metrics = config.fields.length === 6
    ? [`${rows.lastOffsetMs}  ${rows.meanOffsetMs}`,rows.meanAbsoluteOffsetMs,rows.standardDeviationMs,`${rows.withinWindowPercent}  ·  ${rows.sampleCount}`]
    : config.fields.map(field => rows[field]);
  return content([...(config.showTitle ? [label(p,'Accuracy · précision','Accuracy · timing')] : []),...metrics,...(config.showCoverage ? [coverage] : [])]);
}
const definitions: WidgetDefinition[] = [
  {type:'gameplay.accuracy',version:1,displayName:'Accuracy · précision',category:'gameplay',defaultSize:{width:400,height:184},defaultConfig:{},requiredCapabilities:['gameplay.timing']},
  {type:'gameplay.combo',version:1,displayName:'Combo et record de session',category:'gameplay',defaultSize:{width:300,height:70},defaultConfig:{},requiredCapabilities:['gameplay.combo']},
  {type:'gameplay.fc',version:1,displayName:'Suivi FC',category:'gameplay',defaultSize:{width:340,height:104},defaultConfig:{},requiredCapabilities:['gameplay.fc']},
  {type:'gameplay.progress',version:1,displayName:'Progression du morceau',category:'gameplay',defaultSize:{width:440,height:72},defaultConfig:{},requiredCapabilities:['gameplay.progress']},
  {type:'gameplay.comparison',version:1,displayName:'Comparaison du meilleur score',category:'gameplay',defaultSize:{width:400,height:104},defaultConfig:{},requiredCapabilities:['gameplay.comparison']},
  {type:'session.goal',version:1,displayName:'Objectif de session',category:'stream',defaultSize:{width:400,height:104},defaultConfig:{},requiredCapabilities:['session.goal']},
  {type:'session.history',version:1,displayName:'Cinq derniers essais',category:'stream',defaultSize:{width:680,height:184},defaultConfig:{},requiredCapabilities:['session.history']},
  {type:'song.lyrics',version:1,displayName:'Paroles synchronisées',category:'song',defaultSize:{width:720,height:100},defaultConfig:{},requiredCapabilities:[]}
];
const renderers: Record<string, (p: GameplayTelemetry) => WidgetContent | null> = {
  'gameplay.accuracy': p => accuracy(p,validateAccuracyConfig({})),
  'gameplay.combo': p => content([`${label(p,'Combo','Combo')}: ${format(p,p.active?.stats.combo)}`,`${label(p,'Record de session','Session record')}: ${format(p,p.session.bestCombo)}`]),
  'gameplay.fc': p => {
    const a=p.active,s=a?.stats;if(!a||!s)return null;
    const known=finite(s.notesHit)&&finite(s.notesTotal)&&s.notesTotal>0&&s.notesHit<=s.notesTotal;
    const eligible=known&&a.coverage==='complete'&&s.misses===0&&s.overstrums===0;
    let status=label(p,'Essai en cours','Attempt in progress');
    if(a.ended){
      if(a.completed===false)status=label(p,'Essai interrompu','Interrupted attempt');
      else if(a.completed===true&&eligible&&s.notesHit===s.notesTotal)status='FC';
      else status=label(p,'Résultat sans FC confirmé','No confirmed FC');
    }else if(p.phase==='results'||a.coverage!=='complete')status=label(p,'FC non confirmé','FC unconfirmed');
    else if(eligible&&['playing','paused'].includes(p.phase))status=label(p,'FC possible','FC possible');
    return content([`FC · ${status}`,`${label(p,'Ratées','Misses')}: ${format(p,s.misses)}  ·  ${label(p,'Surstrums','Overstrums')}: ${format(p,s.overstrums)}`,`${label(p,'Notes touchées','Notes hit')}: ${format(p,s.notesHit)} / ${format(p,s.notesTotal)}`]);
  },
  'gameplay.progress': p => { const c=p.active?.clock;if(!c||c.durationSeconds<=0)return null;const elapsed=Math.max(0,Math.min(c.durationSeconds,c.positionSeconds));return content([label(p,'Progression du morceau','Song progress'),`${time(elapsed)} / ${time(c.durationSeconds)}  ·  ${label(p,'Reste','Remaining')} ${time(c.durationSeconds-elapsed)}`]);},
  'gameplay.comparison': p => content([label(p,'Meilleur score','Personal best'),`${label(p,'Score','Score')}: ${format(p,p.comparison.currentScore)}  ·  ${label(p,'Record précédent','Previous best')}: ${format(p,p.comparison.bestScore)}`,p.active?.coverage!=='complete' ? label(p,'Essai partiel · record inchangé','Partial attempt · best unchanged') : p.comparison.delta===null ? p.comparison.bestScore===null ? label(p,'Premier essai mesuré pour cette chart','First measured attempt for this chart') : label(p,'Différence indisponible','Difference unavailable') : `${label(p,'Différence','Difference')}: ${p.comparison.delta>0?'+':''}${format(p,p.comparison.delta)}`]),
  'session.goal': p => {const unit=p.goal.kind==='songs'?label(p,'morceaux','songs'):p.goal.kind==='fc'?'FC':'min';return content([label(p,'Objectif de session','Session goal'),`${format(p,p.goal.value,p.goal.kind==='minutes'?1:0)} / ${format(p,p.goal.target)} ${unit}  ·  ${format(p,p.goal.percent)} %`,`${label(p,'Durée de session','Session duration')}: ${time(p.session.durationSeconds)}`]);},
  'session.history': p => content([label(p,'Cinq derniers essais','Last five attempts'),...p.history.slice(0,5).map((h,i)=>`${i+1}. ${format(p,h.score)}${h.fullCombo===true?' · FC':''}${h.coverage!=='complete'?' · '+label(p,'essai partiel','partial attempt'):!h.completed?' · '+label(p,'interrompu','interrupted'):''} · ${h.title||label(p,'Morceau','Song')}`)])
};
export const gameplayWidgets = definitions.map(definition => ({definition,component: ((state: AppState, instance: WidgetInstance) => {
  if (definition.type === 'song.lyrics') {
    if (!state.lyrics?.current || !['playing','paused'].includes(state.gameplay.state)) return null;
    return content([state.lyrics.current,...(validateLyricsConfig(instance.config).showNextLine && state.lyrics.next ? [state.lyrics.next] : [])]);
  }
  return state.performance ? definition.type === 'gameplay.accuracy' ? accuracy(state.performance,validateAccuracyConfig(instance.config)) : renderers[definition.type]!(state.performance) : null;
}) as WidgetComponent}));
export function createGameplayWidgets(): WidgetInstance[] {
  const positions=[[816,32],[48,32],[48,124],[48,256],[816,238],[816,368],[48,348],[280,600]];
  return definitions.map((definition,i)=>({id:definition.type.replace('.','-'),type:definition.type,enabled:true,position:{x:positions[i]![0]!,y:positions[i]![1]!},size:{...definition.defaultSize},visibility:{game:false,stream:false},gameplayVisibility:['idle','menu','loading','playing','paused','results'],style:{fontSize:definition.type==='gameplay.accuracy'?16:20,fontWeight:500,colorMode:'theme'},config:{}}));
}
/** Append only missing optional instances. Existing layouts and styles are kept. */
export function ensureGameplayDocument(document: SettingsDocument): SettingsDocument {
  const ids=new Set(document.widgets.map(w=>w.id)),available=createGameplayWidgets().filter(w=>!ids.has(w.id)).slice(0,Math.max(0,100-document.widgets.length));
  if(!available.length)return document;
  const defaults=createDefaultStream(available);return {...document,widgets:[...document.widgets,...available],stream:{...document.stream,layout:[...document.stream.layout,...defaults.layout]}};
}
