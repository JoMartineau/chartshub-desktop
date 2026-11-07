'use strict';
const { runtime: localeRuntime } = require('../desktop/language.cjs');
const DEFAULT_SESSION_WIDGET_SETTINGS = Object.freeze({ shareChat: false, shareActivity: false, showViewerNames: false, fontSize: 18, maxItems: 6, accent: '#49bbff' });
const KEYS = Object.keys(DEFAULT_SESSION_WIDGET_SETTINGS).sort(), KINDS = new Set(['chat', 'activity']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const clean = (value, length) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, length).replace(/[\ud800-\udbff]$/u, '') : '';
function defaultSessionWidgetSettings() { return { ...DEFAULT_SESSION_WIDGET_SETTINGS }; }
function validateSessionWidgetSettings(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== KEYS.join(',') || ['shareChat', 'shareActivity', 'showViewerNames'].some(key => typeof value[key] !== 'boolean')
      || !Number.isSafeInteger(value.fontSize) || value.fontSize < 12 || value.fontSize > 48 || !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 20 || typeof value.accent !== 'string' || !/^#[a-f0-9]{6}$/i.test(value.accent)) throw Object.assign(Error('Invalid session widget settings'), { code: 'SESSION_WIDGETS_INVALID_SETTINGS' });
  return { shareChat: value.shareChat, shareActivity: value.shareActivity, showViewerNames: value.showViewerNames, fontSize: value.fontSize, maxItems: value.maxItems, accent: value.accent.toLowerCase() };
}
function validSessionWidgetCommand(name, payload) {
  if (!plain(payload)) return false;
  if (name === 'sessionWidgets.copyUrl') return Object.keys(payload).join(',') === 'kind' && KINDS.has(payload.kind);
  if (name !== 'sessionWidgets.configure' || Object.keys(payload).sort().join(',') !== 'revision,settings' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) return false;
  try { validateSessionWidgetSettings(payload.settings); return true; } catch { return false; }
}
function projectSessionFeed(kind, value) {
  const defaults = defaultSessionWidgetSettings(), language = localeRuntime.canonicalize(value?.language) || 'en';
  let settings = defaults;
  try { settings = validateSessionWidgetSettings(value?.settings); } catch {}
  const enabled = KINDS.has(kind) && value?.enabled === true && settings[kind === 'chat' ? 'shareChat' : 'shareActivity'] === true;
  const result = { enabled, language, settings: { fontSize: settings.fontSize, maxItems: settings.maxItems, accent: settings.accent, showViewerNames: kind === 'chat' || settings.showViewerNames }, items: [] };
  if (!enabled || !Array.isArray(value?.items)) return result;
  for (const item of value.items.slice(-100)) {
    if (!plain(item) || typeof item.id !== 'string' || !/^\d{1,16}$/.test(item.id) || !Number.isSafeInteger(item.at) || item.at < 0) continue;
    const platform = ['twitch', 'tiktok', 'youtube', 'website', 'desktop'].includes(item.platform) ? item.platform : 'desktop';
    if (kind === 'chat') {
      const name = clean(item.name, 80), text = clean(item.text, 500);
      if (name && text && ['twitch', 'tiktok'].includes(platform)) result.items.push({ id: item.id, platform, name, text, at: item.at });
    } else if (['request', 'download'].includes(item.kind) && (item.kind === 'request' ? ['added', 'accepted', 'played'].includes(item.action) : item.action === 'completed')) {
      const title = clean(item.title, 200); if (title) result.items.push({ id: item.id, kind: item.kind, action: item.action, title, platform, ...(settings.showViewerNames && clean(item.name, 80) ? { name: clean(item.name, 80) } : {}), at: item.at });
    }
  }
  result.items = result.items.slice(-settings.maxItems);
  while (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) result.items.shift();
  return result;
}
module.exports = { DEFAULT_SESSION_WIDGET_SETTINGS, defaultSessionWidgetSettings, validateSessionWidgetSettings, validSessionWidgetCommand, projectSessionFeed };
