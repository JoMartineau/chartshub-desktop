import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WidgetInstance } from '../core/types/Widget.js';
import type { GameplayState } from '../core/types/GameplayState.js';
import type { ThemeSettings } from '../themes/types.js';
import { createDefaultTheme, validateTheme } from '../themes/ThemeService.js';
import { validateWidgetStyle } from '../themes/ThemeResolver.js';
import { normalizeColor } from '../themes/normalizeColor.js';
import { createDefaultStream, validateStream, type StreamSettings } from '../overlay/stream/StreamConfig.js';

export interface SettingsDocument { version: 3; widgets: WidgetInstance[]; theme: ThemeSettings; stream: StreamSettings; }
export interface LegacySettingsDocument { version: 1; widgets: WidgetInstance[]; }
export interface ThemeSettingsDocument { version: 2; widgets: WidgetInstance[]; theme: ThemeSettings; }
export type SettingsInput = SettingsDocument | LegacySettingsDocument | ThemeSettingsDocument;
const states: GameplayState[] = ['idle', 'menu', 'loading', 'playing', 'paused', 'results'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
// These are the shipped v1 defaults, deliberately independent of future presets.
const legacyColors: Record<string, string> = {
  'song.title': '#ffffff', 'song.artist': '#e0e7ff', 'song.charter': '#aebbd0',
  'song.instrument': '#c4b5fd', 'song.difficulty': '#c4b5fd'
};

export function validateSettings(value: unknown): SettingsDocument {
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.widgets) || value.widgets.length > 100) throw Error('Format de réglages non pris en charge.');
  const theme = value.version === 1 ? createDefaultTheme() : validateTheme(value.theme);
  const ids = new Set<string>();
  const widgets = value.widgets.map((w: unknown): WidgetInstance => {
    if (!record(w) || typeof w.id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(w.id) || ids.has(w.id) || typeof w.type !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(w.type)) throw Error('Identifiant de widget invalide.');
    ids.add(w.id);
    if (w.locked !== undefined && typeof w.locked !== 'boolean') throw Error('Verrouillage de widget invalide.');
    if (typeof w.enabled !== 'boolean' || !record(w.position) || !number(w.position.x, 0, 8192) || !number(w.position.y, 0, 8192) || !record(w.size) || !number(w.size.width, 1, 8192) || !number(w.size.height, 1, 8192) || !record(w.visibility) || typeof w.visibility.game !== 'boolean' || typeof w.visibility.stream !== 'boolean') throw Error('Disposition de widget invalide.');
    if (w.gameplayVisibility !== undefined && (!Array.isArray(w.gameplayVisibility) || w.gameplayVisibility.length > 6 || w.gameplayVisibility.some(s => !states.includes(s as GameplayState)))) throw Error('Visibilité de widget invalide.');
    if (!record(w.style) || !record(w.config)) throw Error('Configuration de widget invalide.');
    const style = validateWidgetStyle(w.style);
    if (value.version === 1 && w.style.colorMode === undefined) {
      const legacyColor = Object.hasOwn(legacyColors, w.type) ? normalizeColor(legacyColors[w.type]!) : null;
      style.colorMode = style.color === undefined || style.color === legacyColor ? 'theme' : 'custom';
    }
    return { id: w.id, type: w.type, enabled: w.enabled, ...(w.locked === undefined ? {} : { locked: w.locked }), position: { x: w.position.x, y: w.position.y }, size: { width: w.size.width, height: w.size.height }, visibility: { game: w.visibility.game, stream: w.visibility.stream }, ...(w.gameplayVisibility === undefined ? {} : { gameplayVisibility: [...w.gameplayVisibility as GameplayState[]] }), style, config: structuredClone(w.config) };
  });
  const stream = value.version === 3 ? validateStream(value.stream, widgets) : createDefaultStream(widgets);
  return { version: 3, widgets, theme, stream };
}

/** Main process only. Widget components never import this repository. */
export class SettingsRepository {
  private tail: Promise<void> = Promise.resolve();
  private futureVersion = false;
  constructor(private readonly filePath: string, private readonly defaults: WidgetInstance[]) {}
  async load(): Promise<SettingsDocument> {
    let text: string;
    try { const info = await fs.stat(this.filePath); if (info.size > 262144) throw Error('Fichier de réglages trop volumineux.'); text = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateSettings({ version: 2, widgets: this.defaults, theme: createDefaultTheme() }); throw error; }
    const parsed: unknown = JSON.parse(text);
    if (record(parsed) && typeof parsed.version === 'number' && parsed.version > 3) { this.futureVersion = true; throw Error('Réglages créés par une version plus récente.'); }
    return validateSettings(parsed);
  }
  save(document: SettingsInput): Promise<void> {
    if (this.futureVersion) return Promise.reject(Error('Les réglages d’une version plus récente sont conservés sans modification.'));
    const snapshot = validateSettings(document);
    const text = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(text) > 262144) return Promise.reject(Error('Réglages trop volumineux.'));
    const operation = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = this.filePath + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        try { await fs.copyFile(this.filePath, this.filePath + '.bak'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await fs.rename(temporary, this.filePath);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
