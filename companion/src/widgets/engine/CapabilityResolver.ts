import type { AppState } from '../../core/state/AppState.js';
import type { Capability, WidgetDefinition } from '../../core/types/Widget.js';
import { selectArtist, selectCharter, selectDifficulty, selectInstrument, selectSongTitle } from './WidgetSelectors.js';
import type { WidgetTextSelector } from './WidgetSelectors.js';

const capabilitySelectors: Record<Capability, WidgetTextSelector | ((state: AppState) => boolean)> = {
  'song.title': selectSongTitle,
  'song.artist': selectArtist,
  'song.charter': selectCharter,
  'song.instrument': selectInstrument,
  'song.difficulty': selectDifficulty,
  'gameplay.timing': state => state.performance?.connected === true && state.performance.capabilities.hitTiming && state.performance.timing.sampleCount > 0,
  'gameplay.combo': state => state.performance?.connected === true && state.performance.capabilities.combo && state.performance.active?.stats.combo != null,
  'gameplay.fc': state => state.performance?.connected === true && state.performance.capabilities.misses && state.performance.capabilities.overstrums && state.performance.capabilities.attemptResults && state.performance.active?.stats.notesTotal != null,
  'gameplay.progress': state => state.performance?.connected === true && state.performance.capabilities.clock && (state.performance.active?.clock?.durationSeconds ?? 0) > 0,
  'gameplay.comparison': state => state.performance?.connected === true && state.performance.capabilities.score && state.performance.hasChartIdentity === true && state.performance.comparison.currentScore != null,
  'session.goal': state => !!state.performance && (state.performance.goal.kind === 'minutes' || state.performance.goal.kind === 'songs' && state.performance.capabilities.attemptResults || state.performance.goal.kind === 'fc' && state.performance.capabilities.attemptResults && state.performance.capabilities.misses && state.performance.capabilities.overstrums),
  'session.history': state => !!state.performance && state.performance.history.length > 0
};

/** Unknown capabilities fail closed until a state-backed resolver is available. */
export function hasCapabilities(definition: WidgetDefinition, state: AppState): boolean {
  return (definition.requiredCapabilities ?? []).every(capability => {
    if (!Object.hasOwn(capabilitySelectors, capability)) return false;
    const selector = capabilitySelectors[capability];
    if (typeof selector !== 'function') return false;
    const value = selector(state);
    return typeof value === 'boolean' ? value : value !== null;
  });
}
