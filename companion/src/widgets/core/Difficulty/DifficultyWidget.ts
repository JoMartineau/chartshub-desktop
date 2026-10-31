import type { WidgetDefinition } from '../../../core/types/Widget.js';
import type { WidgetComponent } from '../../engine/WidgetRegistry.js';
import { selectLocalizedDifficulty } from '../../engine/WidgetSelectors.js';

export const difficultyDefinition: WidgetDefinition = {
  type: 'song.difficulty', version: 1, displayName: 'Difficulty', category: 'song',
  defaultSize: { width: 180, height: 28 }, defaultConfig: {}, requiredCapabilities: ['song.difficulty']
};

export const DifficultyWidget: WidgetComponent = state => {
  const text = selectLocalizedDifficulty(state);
  return text === null ? null : { text };
};
