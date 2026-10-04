import type { WidgetInstance } from '../../core/types/Widget.js';

export interface WidgetRenderError {
  widgetId: string;
  widgetType: string;
  code: 'WIDGET_RENDER_FAILED';
  message: 'Widget could not be rendered.';
}
export type WidgetErrorHandler = (error: WidgetRenderError) => void;

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** A failed widget is retried next render; error details never enter the overlay. */
export class WidgetErrorBoundary {
  constructor(private readonly onError?: WidgetErrorHandler) {}

  run<T>(instance: Pick<WidgetInstance, 'id' | 'type'>, render: () => T): T | null {
    try {
      return render();
    } catch {
      try {
        this.onError?.({
          widgetId: safeIdentifier(instance.id),
          widgetType: safeIdentifier(instance.type),
          code: 'WIDGET_RENDER_FAILED',
          message: 'Widget could not be rendered.'
        });
      } catch {
        // Diagnostics are optional and must not interrupt the other widgets.
      }
      return null;
    }
  }
}
