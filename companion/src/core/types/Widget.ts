import type { GameplayState } from './GameplayState.js';

export type WidgetDestination = 'game' | 'stream';
export type Capability = 'song.title' | 'song.artist' | 'song.charter' | 'song.instrument' | 'song.difficulty';
export interface WidgetStyle {
  colorMode?: 'theme' | 'custom';
  useSourceColors?: boolean;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  backgroundColor?: string;
  borderColor?: string;
  glow?: { enabled: boolean; color: string; blur: number };
  gradient?: { enabled: boolean; from: string; to: string; angle: number };
}
export interface WidgetInstance {
  id: string;
  type: string;
  enabled: boolean;
  /** Shared by game and stream; only geometry editing is blocked. */
  locked?: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  visibility: { game: boolean; stream: boolean };
  gameplayVisibility?: GameplayState[];
  style: WidgetStyle;
  config: Record<string, unknown>;
}
export interface WidgetDefinition {
  type: string;
  version: number;
  displayName: string;
  category: 'song' | 'gameplay' | 'requests' | 'downloads' | 'stream' | 'system';
  defaultSize: { width: number; height: number };
  defaultConfig: Record<string, unknown>;
  requiredCapabilities?: Capability[];
}
export interface WidgetEngineState { instances: WidgetInstance[]; }
