import type { AppState } from '../../core/state/AppState.js';
import type { WidgetRenderer } from '../../widgets/engine/WidgetRenderer.js';

/** Places the shared widget renderer on a fixed logical canvas in any game surface. */
export class GameOverlay {
  static readonly width = 1280;
  static readonly height = 720;

  private readonly canvas: HTMLDivElement;
  private readonly observer: ResizeObserver;

  constructor(private readonly container: HTMLElement, private readonly renderer: WidgetRenderer) {
    this.canvas = container.ownerDocument.createElement('div');
    this.canvas.className = 'game-overlay-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.width = `${GameOverlay.width}px`;
    this.canvas.style.height = `${GameOverlay.height}px`;
    this.canvas.style.transformOrigin = 'top left';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.setAttribute('aria-label', 'Informations du morceau en cours');
    this.container.append(this.canvas);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  render(state: AppState): void {
    this.renderer.render(this.canvas, state, 'game');
  }

  dispose(): void {
    this.observer.disconnect();
    this.canvas.remove();
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const scale = Math.max(0, Math.min(width / GameOverlay.width, height / GameOverlay.height));
    this.canvas.style.left = `${(width - GameOverlay.width * scale) / 2}px`;
    this.canvas.style.top = `${(height - GameOverlay.height * scale) / 2}px`;
    this.canvas.style.transform = `scale(${scale})`;
  }
}
