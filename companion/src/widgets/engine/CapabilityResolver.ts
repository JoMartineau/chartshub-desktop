import type { AppState } from '../../core/state/AppState.js';
import type { Capability, WidgetDefinition } from '../../core/types/Widget.js';
import { selectArtist, selectCharter, selectDifficulty, selectInstrument, selectSongTitle } from './WidgetSelectors.js';
import type { WidgetTextSelector } from './WidgetSelectors.js';

const capabilitySelectors: Record<Capability, WidgetTextSelector> = {
  'song.title': selectSongTitle,
  'song.artist': selectArtist,
  'song.charter': selectCharter,
  'song.instrument': selectInstrument,
  'song.difficulty': selectDifficulty
};

/** Unknown capabilities fail closed until a state-backed resolver is available. */
export function hasCapabilities(definition: WidgetDefinition, state: AppState): boolean {
  return (definition.requiredCapabilities ?? []).every(capability => {
    if (!Object.hasOwn(capabilitySelectors, capability)) return false;
    const selector = capabilitySelectors[capability];
    return typeof selector === 'function' && selector(state) !== null;
  });
}
