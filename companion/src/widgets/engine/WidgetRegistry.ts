import type { AppState } from '../../core/state/AppState.js';
import type { ColoredTextSegment } from '../../core/types/ColoredText.js';
import type { WidgetDefinition, WidgetInstance } from '../../core/types/Widget.js';

export interface WidgetContent { text: string; segments?: ColoredTextSegment[]; }
export type WidgetComponent = (state: AppState, instance: WidgetInstance) => WidgetContent | null;
export interface RegisteredWidget { definition: WidgetDefinition; component: WidgetComponent; }

/** Registration is the only connection between a widget type and its component. */
export class WidgetRegistry {
  private readonly registrations = new Map<string, RegisteredWidget>();

  register(definition: WidgetDefinition, component: WidgetComponent): void {
    if (!definition.type.trim()) throw new Error('A widget type is required.');
    if (this.registrations.has(definition.type)) throw new Error(`Widget already registered: ${definition.type}`);
    this.registrations.set(definition.type, { definition, component });
  }

  get(type: string): RegisteredWidget | undefined { return this.registrations.get(type); }
  getAll(): RegisteredWidget[] { return [...this.registrations.values()]; }
}
