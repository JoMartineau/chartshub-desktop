import type { GameplaySessionState } from '../types/GameplayState.js';
import type { NowPlayingState } from '../types/NowPlaying.js';
import type { ServiceHealth } from '../types/ServiceHealth.js';
import type { WidgetEngineState } from '../types/Widget.js';
import type { ThemeSettings } from '../../themes/types.js';
import type { StreamSettings } from '../../overlay/stream/StreamConfig.js';

export interface AppState {
  gameplay: GameplaySessionState;
  nowPlaying: NowPlayingState | null;
  serviceHealth: Record<string, ServiceHealth>;
  widgets: WidgetEngineState;
  theme?: ThemeSettings;
  stream?: StreamSettings;
}
