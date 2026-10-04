import type { WidgetDefinition } from '../../../core/types/Widget.js';
import type { WidgetComponent } from '../../engine/WidgetRegistry.js';
import { selectInstrument } from '../../engine/WidgetSelectors.js';

export const instrumentDefinition: WidgetDefinition = {
  type: 'song.instrument', version: 1, displayName: 'Instrument', category: 'song',
  defaultSize: { width: 110, height: 28 }, defaultConfig: {}, requiredCapabilities: ['song.instrument']
};

export const InstrumentWidget: WidgetComponent = state => {
  const text = selectInstrument(state);
  return text === null ? null : { text };
};
