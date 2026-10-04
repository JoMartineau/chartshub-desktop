import type { AppState } from '../../core/state/AppState.js';
import type { WidgetDefinition, WidgetDestination, WidgetInstance } from '../../core/types/Widget.js';
import { hasCapabilities } from './CapabilityResolver.js';

export function isWidgetVisible(
  instance: WidgetInstance,
  definition: WidgetDefinition,
  state: AppState,
  destination: WidgetDestination = 'game'
): boolean {
  if (!instance.enabled || !instance.visibility[destination]) return false;
  if (!(instance.gameplayVisibility ?? ['playing', 'paused']).includes(state.gameplay.state)) return false;
  // Metadata can outlive a chart. Song widgets require a real active session.
  // Other categories can eventually show menu widgets without claiming a chart is active.
  if (definition.category === 'song' && !state.gameplay.isChartActive) return false;
  return hasCapabilities(definition, state);
}
