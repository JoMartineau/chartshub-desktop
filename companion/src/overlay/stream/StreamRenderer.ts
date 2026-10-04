import type { AppState } from '../../core/state/AppState.js';
import type { WidgetRenderer } from '../../widgets/engine/WidgetRenderer.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../../layout/WidgetLayoutEngine.js';
import { projectStreamState } from './StreamConfig.js';

/** Shared widget rendering on a transparent, fixed logical scene for previews and OBS. */
export class StreamRenderer {
  static readonly width = CANVAS_WIDTH;
  static readonly height = CANVAS_HEIGHT;
  private readonly canvas: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly renderer: WidgetRenderer) {
    this.canvas = container.ownerDocument.createElement('div');
    this.canvas.className = 'stream-overlay-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      width: `${StreamRenderer.width}px`,
      height: `${StreamRenderer.height}px`,
      transformOrigin: 'top left',
      pointerEvents: 'none',
    });
    this.canvas.setAttribute('aria-label', 'Informations du morceau pour le stream');
    container.append(this.canvas);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  render(state: AppState): void {
    if (this.disposed) return;
    this.renderer.render(this.canvas, projectStreamState(state), 'stream');
    this.resize();
  }

  clear(): void {
    if (!this.disposed) this.canvas.replaceChildren();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.canvas.remove();
  }

  private resize(): void {
    if (this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const scale = Math.max(0, Math.min(width / StreamRenderer.width, height / StreamRenderer.height));
    // Custom viewport ratios keep the logical composition centered with transparent letterboxing.
    this.canvas.style.left = `${(width - StreamRenderer.width * scale) / 2}px`;
    this.canvas.style.top = `${(height - StreamRenderer.height * scale) / 2}px`;
    this.canvas.style.transform = `scale(${scale})`;
  }
}
