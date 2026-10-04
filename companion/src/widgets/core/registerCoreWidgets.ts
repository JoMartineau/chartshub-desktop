import type { WidgetInstance } from '../../core/types/Widget.js';
import { WidgetRegistry } from '../engine/WidgetRegistry.js';
import { ArtistWidget, artistDefinition } from './Artist/ArtistWidget.js';
import { CharterWidget, charterDefinition } from './Charter/CharterWidget.js';
import { DifficultyWidget, difficultyDefinition } from './Difficulty/DifficultyWidget.js';
import { InstrumentWidget, instrumentDefinition } from './Instrument/InstrumentWidget.js';
import { SongTitleWidget, songTitleDefinition } from './SongTitle/SongTitleWidget.js';

export function registerCoreWidgets(registry: WidgetRegistry): void {
  registry.register(songTitleDefinition, SongTitleWidget);
  registry.register(artistDefinition, ArtistWidget);
  registry.register(charterDefinition, CharterWidget);
  registry.register(instrumentDefinition, InstrumentWidget);
  registry.register(difficultyDefinition, DifficultyWidget);
}

export function createDefaultRegistry(): WidgetRegistry {
  const registry = new WidgetRegistry();
  registerCoreWidgets(registry);
  return registry;
}

/** Fixed IDs let persisted settings match the same five independent instances. */
export function createDefaultWidgets(): WidgetInstance[] {
  const defaults = [
    { id: 'song-title', definition: songTitleDefinition, x: 48, y: 440, fontSize: 34, fontWeight: 700, color: '#ffffff' },
    { id: 'song-artist', definition: artistDefinition, x: 48, y: 496, fontSize: 22, fontWeight: 500, color: '#e0e7ff' },
    { id: 'song-charter', definition: charterDefinition, x: 48, y: 546, fontSize: 14, fontWeight: 500, color: '#aebbd0' },
    { id: 'song-instrument', definition: instrumentDefinition, x: 48, y: 582, fontSize: 14, fontWeight: 600, color: '#c4b5fd' },
    { id: 'song-difficulty', definition: difficultyDefinition, x: 174, y: 582, fontSize: 14, fontWeight: 600, color: '#c4b5fd' }
  ];
  return defaults.map(({ id, definition, x, y, fontSize, fontWeight, color }) => ({
    id,
    type: definition.type,
    enabled: true,
    position: { x, y },
    size: { ...definition.defaultSize },
    visibility: { game: true, stream: false },
    gameplayVisibility: ['playing', 'paused'],
    style: { fontSize, fontWeight, color, colorMode: 'theme' },
    config: { ...definition.defaultConfig }
  }));
}
