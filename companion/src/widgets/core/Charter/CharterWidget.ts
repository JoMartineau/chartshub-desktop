import type { WidgetDefinition } from '../../../core/types/Widget.js';
import { validateColoredTextSegments } from '../../../core/types/ColoredText.js';
import type { WidgetComponent } from '../../engine/WidgetRegistry.js';
import { selectCharter } from '../../engine/WidgetSelectors.js';

export const charterDefinition: WidgetDefinition = {
  type: 'song.charter', version: 1, displayName: 'Charter', category: 'song',
  defaultSize: { width: 720, height: 28 }, defaultConfig: {}, requiredCapabilities: ['song.charter']
};

export const CharterWidget: WidgetComponent = state => {
  const text = selectCharter(state);
  if (text === null) return null;
  const segments = validateColoredTextSegments(state.nowPlaying?.charterSegments, text);
  return { text, ...(segments ? { segments } : {}) };
};
