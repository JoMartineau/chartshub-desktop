import type { WidgetDefinition } from '../../../core/types/Widget.js';
import type { WidgetComponent } from '../../engine/WidgetRegistry.js';
import { selectArtist } from '../../engine/WidgetSelectors.js';

export const artistDefinition: WidgetDefinition = {
  type: 'song.artist', version: 1, displayName: 'Artist', category: 'song',
  defaultSize: { width: 720, height: 38 }, defaultConfig: {}, requiredCapabilities: ['song.artist']
};

export const ArtistWidget: WidgetComponent = state => {
  const text = selectArtist(state);
  return text === null ? null : { text };
};
