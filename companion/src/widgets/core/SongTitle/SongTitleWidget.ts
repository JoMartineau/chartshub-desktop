import type { WidgetDefinition } from '../../../core/types/Widget.js';
import type { WidgetComponent } from '../../engine/WidgetRegistry.js';
import { selectSongTitle } from '../../engine/WidgetSelectors.js';

export const songTitleDefinition: WidgetDefinition = {
  type: 'song.title', version: 1, displayName: 'Song Title', category: 'song',
  defaultSize: { width: 720, height: 50 }, defaultConfig: {}, requiredCapabilities: ['song.title']
};

export const SongTitleWidget: WidgetComponent = state => {
  const text = selectSongTitle(state);
  return text === null ? null : { text };
};
