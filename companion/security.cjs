'use strict';
const path = require('node:path');
const fs = require('node:fs');
function assetPath(root, value) {
  let url, pathname;
  try { url = new URL(value); pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (url.protocol !== 'chartshub-companion:' || url.hostname !== 'app' || url.username || url.password || url.port || !/^\/(ui|dist)\//.test(pathname) || pathname.includes('\\') || pathname.includes('\0')) return null;
  const candidate = path.resolve(root, '.' + pathname);
  if (!candidate.startsWith(path.resolve(root) + path.sep)) return null;
  if (!['ui','dist'].some(folder => candidate.startsWith(path.resolve(root, folder) + path.sep))) return null;
  try {
    const actual = fs.realpathSync(candidate), base = fs.realpathSync(root);
    const folder = candidate.startsWith(path.resolve(root, 'ui') + path.sep) ? 'ui' : 'dist';
    const allowed = fs.realpathSync(path.join(root, folder));
    if (!allowed.startsWith(base + path.sep) || !actual.startsWith(allowed + path.sep)) return null;
  } catch { return null; }
  return candidate;
}
function trustedContentsSender(event, contents, page) {
  if (!contents || contents.isDestroyed?.() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.href === 'chartshub-companion://app/ui/' + page; } catch { return false; }
}
function trustedSender(event, window, page) {
  return !!window && !window.isDestroyed() && trustedContentsSender(event, window.webContents, page);
}
function trustedFiltersWidgetCommand(event, window, command, payload) {
  return (['filters.settings', 'filters.openPanel', 'reshade.command'].includes(command)
    || (command === 'panels.appearance' && payload?.panel === 'filters')) && trustedSender(event, window, 'filters-widget.html');
}
function trustedCatalogueWidgetCommand(event, window, command, payload) {
  return (['catalogue.widget', 'catalogue.search', 'catalogue.refresh', 'catalogue.favorite', 'downloads.enqueue', 'downloads.chooseRoot', 'downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.retry'].includes(command)
    || (command === 'panels.appearance' && payload?.panel === 'catalogue')) && trustedSender(event, window, 'catalogue-widget.html');
}
function validCommand(command, payload, widgetIds) {
  if (command === 'player.search') return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).every(key => ['query', 'offset', 'limit', 'filters'].includes(key))
    && typeof payload.query === 'string' && payload.query.length <= 200 && !/[\x00-\x1f\x7f]/.test(payload.query)
    && (payload.offset === undefined || (Number.isSafeInteger(payload.offset) && payload.offset >= 0 && payload.offset <= 1000000))
    && (payload.limit === undefined || (Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 50))
    && (payload.filters === undefined || (!!payload.filters && typeof payload.filters === 'object' && !Array.isArray(payload.filters)
      && Object.keys(payload.filters).length === 9 && Object.keys(payload.filters).every(key => ['artist','charter','album','year','genre','audio','format','instrument','difficulty'].includes(key))
      && ['artist','charter','album','year','genre'].every(key => typeof payload.filters[key] === 'string' && payload.filters[key].length <= 200 && !/[\x00-\x1f\x7f]/.test(payload.filters[key]))
      && ['all','present','missing','unknown'].includes(payload.filters.audio) && ['all','chart','midi','sng'].includes(payload.filters.format)
      && require('./song-requests.cjs').INSTRUMENTS.includes(payload.filters.instrument) && require('./song-requests.cjs').DIFFICULTIES.includes(payload.filters.difficulty)));
  if (command === 'player.appearance') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload,'appearance')) return false;
    try { require('./music-player-preferences.cjs').validateAppearance(payload.appearance); return true; } catch { return false; }
  }
  if (command === 'player.select') return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === 1 && typeof payload.id === 'string' && /^[a-f0-9]{64}$/.test(payload.id);
  if (['player.widget', 'player.video', 'player.shuffle'].includes(command)) return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === 1 && typeof payload.enabled === 'boolean';
  if (command === 'player.ended') return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 2 && Object.keys(payload).every(key => ['revision','epoch'].includes(key)) && [payload.revision,payload.epoch].every(value => Number.isSafeInteger(value) && value >= 0);
  if (command === 'player.playPlaylist') return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 1
    && (payload.id === null || (typeof payload.id === 'string' && require('./music-playlists.cjs').PLAYLIST_ID.test(payload.id)));
  if (typeof command === 'string' && command.startsWith('player.playlist')) {
    const { PLAYLIST_ID, validPlaylistName } = require('./music-playlists.cjs');
    const fields = { 'player.playlistCreate': ['name'], 'player.playlistRename': ['id','name'], 'player.playlistDelete': ['id'], 'player.playlistAdd': ['id','songId'], 'player.playlistRemove': ['id','songId'] }[command];
    return !!fields && !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === fields.length && Object.keys(payload).every(key => fields.includes(key))
      && (!fields.includes('id') || (typeof payload.id === 'string' && PLAYLIST_ID.test(payload.id))) && (!fields.includes('name') || validPlaylistName(payload.name))
      && (!fields.includes('songId') || (typeof payload.songId === 'string' && /^[a-f0-9]{64}$/.test(payload.songId)));
  }
  if (command === 'player.control') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const value = ['seek', 'volume'].includes(payload.action);
    return ['play', 'pause', 'stop', 'next', 'previous', 'seek', 'volume'].includes(payload.action)
      && Object.keys(payload).length === (value ? 2 : 1) && Object.keys(payload).every(key => ['action', ...(value ? ['value'] : [])].includes(key))
      && (!value || (Number.isFinite(payload.value) && payload.value >= 0 && payload.value <= (payload.action === 'volume' ? 1 : 86400)));
  }
  if (command === 'player.report') return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === (payload.errorCode === undefined ? 6 : 7)
    && Object.keys(payload).every(key => ['revision', 'epoch', 'playing', 'currentTime', 'duration', 'volume', 'errorCode'].includes(key))
    && [payload.revision, payload.epoch].every(n => Number.isSafeInteger(n) && n >= 0) && typeof payload.playing === 'boolean'
    && [payload.currentTime, payload.duration].every(n => Number.isFinite(n) && n >= 0 && n <= 86400)
    && Number.isFinite(payload.volume) && payload.volume >= 0 && payload.volume <= 1
    && (payload.errorCode === undefined || ['unavailable', 'unsupported', 'playback'].includes(payload.errorCode));
  if (command === 'player.spectrum') return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === 2 && Number.isSafeInteger(payload.revision) && payload.revision >= 0
    && Array.isArray(payload.bands) && payload.bands.length === 32 && payload.bands.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
  if (['songRequests.copyBridgeConfiguration', 'songRequests.copyOverlayUrl', 'songRequests.resetOrder', 'songRequests.publishLibrary', 'songRequests.removeLibrary', 'songRequests.copyLibraryUrl'].includes(command)) return payload == null || (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0);
  if (command === 'songRequests.configure') {
    const { INSTRUMENTS, DIFFICULTIES } = require('./song-requests.cjs');
    const rules = payload?.rules;
    return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 3 && Object.keys(payload).every(key => ['enabled', 'port', 'rules'].includes(key))
      && typeof payload.enabled === 'boolean' && Number.isInteger(payload.port) && payload.port >= 1024 && payload.port <= 65535
      && !!rules && typeof rules === 'object' && !Array.isArray(rules) && Object.keys(rules).length === 3 && Object.keys(rules).every(key => ['maxDurationMinutes', 'instrument', 'difficulty'].includes(key))
      && (rules.maxDurationMinutes === null || (Number.isInteger(rules.maxDurationMinutes) && rules.maxDurationMinutes >= 1 && rules.maxDurationMinutes <= 60))
      && INSTRUMENTS.includes(rules.instrument) && DIFFICULTIES.includes(rules.difficulty);
  }
  if (['songRequests.accept', 'songRequests.reject', 'songRequests.played', 'songRequests.move'].includes(command)) return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.id)
    && Object.keys(payload).length === (command === 'songRequests.move' ? 2 : 1)
    && Object.keys(payload).every(key => ['id', ...(command === 'songRequests.move' ? ['direction'] : [])].includes(key))
    && (command !== 'songRequests.move' || ['up', 'down'].includes(payload.direction));
  if (['mock.next', 'mock.reset', 'editor.undo', 'editor.redo'].includes(command)) return payload === undefined || payload === null;
  if (['stream.copyUrl', 'library.chooseRoot', 'library.cancel', 'library.verifyAllDuplicates', 'catalogue.refresh', 'downloads.chooseRoot', 'clonehero.chooseFile', 'clonehero.detect', 'filters.chooseRoot', 'filters.install', 'filters.restore', 'filters.refresh', 'filters.openPanel', 'reshade.chooseRoot', 'reshade.install', 'reshade.refresh', 'reshade.setupInstall', 'reshade.setupCancel'].includes(command)) return payload === undefined || payload === null || (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0);
  if (command === 'library.cancelDuplicateVerification') return payload == null || (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (command === 'catalogue.widget') return Object.keys(payload).length === 1 && typeof payload.enabled === 'boolean';
  if (command === 'panels.appearance') {
    const style = payload.appearance;
    return Object.keys(payload).length === 3 && Object.keys(payload).every(key => ['revision', 'panel', 'appearance'].includes(key))
      && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && ['catalogue', 'filters'].includes(payload.panel)
      && !!style && typeof style === 'object' && !Array.isArray(style) && Object.keys(style).length === 4
      && Object.keys(style).every(key => ['backgroundColor', 'textColor', 'fontFamily', 'fontSize'].includes(key))
      && ['backgroundColor', 'textColor'].every(key => typeof style[key] === 'string' && style[key].length > 0 && style[key].length <= 128)
      && ['system', 'arial', 'verdana', 'georgia', 'consolas'].includes(style.fontFamily)
      && Number.isInteger(style.fontSize) && style.fontSize >= 10 && style.fontSize <= 24;
  }
  if (command === 'library.cleanupHistory') return Object.keys(payload).every(key => ['offset', 'limit'].includes(key))
    && (payload.offset === undefined || (Number.isSafeInteger(payload.offset) && payload.offset >= 0 && payload.offset <= 200))
    && (payload.limit === undefined || (Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 50));
  if (command === 'reshade.setupPrepare') return Object.keys(payload).length === 1 && typeof payload.includeStarterEffects === 'boolean';
  if (command === 'reshade.command') {
    const keys = Object.keys(payload), only = allowed => keys.length === allowed.length && keys.every(key => allowed.includes(key));
    const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
    if (payload.action === 'enabled') return only(['action', 'enabled']) && typeof payload.enabled === 'boolean';
    if (payload.action === 'technique') return only(['action', 'id', 'enabled']) && id(payload.id) && typeof payload.enabled === 'boolean';
    if (payload.action === 'selectEffect') return only(['action', 'effect']) && typeof payload.effect === 'string' && payload.effect.length > 0 && payload.effect.length <= 512 && !/[\x00-\x1f\x7f]/.test(payload.effect);
    if (payload.action === 'uniform') return only(['action', 'id', 'values']) && id(payload.id) && Array.isArray(payload.values) && payload.values.length > 0 && payload.values.length <= 16 && payload.values.every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)));
    return payload.action === 'save' && only(['action']);
  }
  if (command === 'filters.widget') return typeof payload.enabled === 'boolean' && Object.keys(payload).every(key => key === 'enabled');
  if (command === 'filters.settings') {
    const ranges = { saturation: [0, 2], contrast: [.5, 2], gamma: [.5, 2.5], exposure: [-2, 2], sharpness: [0, 1], vignette: [0, 1] };
    const settings = payload.settings;
    return Object.keys(payload).length === 1 && !!settings && typeof settings === 'object' && !Array.isArray(settings)
      && Object.keys(settings).length === 7 && typeof settings.enabled === 'boolean'
      && Object.entries(ranges).every(([key, [min, max]]) => typeof settings[key] === 'number' && Number.isFinite(settings[key]) && settings[key] >= min && settings[key] <= max)
      && Object.keys(settings).every(key => key === 'enabled' || Object.hasOwn(ranges, key));
  }
  if (command === 'clonehero.mode') return ['live', 'mock'].includes(payload.mode) && Object.keys(payload).every(key => key === 'mode');
  if (command === 'widget.locked') return Number.isSafeInteger(payload.revision) && payload.revision >= 0 && widgetIds.includes(payload.id) && typeof payload.locked === 'boolean'
    && Object.keys(payload).every(key => ['revision', 'id', 'locked'].includes(key));
  if (['profile.save', 'profile.apply', 'profile.delete'].includes(command)) {
    if (!Number.isSafeInteger(payload.profilesRevision) || payload.profilesRevision < 0) return false;
    if (command !== 'profile.delete' && (!Number.isSafeInteger(payload.revision) || payload.revision < 0)) return false;
    const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    if (command === 'profile.save') return (payload.id === undefined || validId(payload.id)) && typeof payload.name === 'string' && payload.name.trim().length > 0 && payload.name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(payload.name)
      && Object.keys(payload).every(key => ['revision', 'profilesRevision', 'id', 'name'].includes(key));
    return validId(payload.id) && Object.keys(payload).every(key => ['profilesRevision', 'id', ...(command === 'profile.apply' ? ['revision'] : [])].includes(key));
  }
  if (command === 'widget.fontSize') return Number.isSafeInteger(payload.revision) && payload.revision >= 0
    && widgetIds.includes(payload.id) && typeof payload.fontSize === 'number' && Number.isFinite(payload.fontSize) && payload.fontSize >= 8 && payload.fontSize <= 200
    && Object.keys(payload).every(key => ['revision', 'id', 'fontSize'].includes(key));
  if (command === 'downloads.enqueue') return typeof payload.chartId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(payload.chartId) && Object.keys(payload).every(key => key === 'chartId');
  if (command === 'catalogue.favorite') return Object.keys(payload).length === 2 && Object.keys(payload).every(key => ['chartId', 'favorite'].includes(key))
    && typeof payload.chartId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(payload.chartId) && typeof payload.favorite === 'boolean';
  if (['downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.retry', 'downloads.remove', 'downloads.openFolder'].includes(command)) return typeof payload.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.id) && Object.keys(payload).every(key => key === 'id');
  if (command === 'catalogue.search') {
    const textFields = ['query', 'artist', 'charter', 'genre', 'year', 'instrument', 'difficulty'];
    return Object.keys(payload).every(key => [...textFields, 'verified', 'installed', 'page', 'favorites'].includes(key))
      && textFields.every(key => typeof payload[key] === 'string' && payload[key].length <= (key === 'query' ? 200 : 128) && !/[\u0000-\u001f\u007f]/.test(payload[key]))
      && ['all', 'yes'].includes(payload.verified) && ['all', 'linked', 'unlinked'].includes(payload.installed)
      && (!Object.hasOwn(payload, 'favorites') || ['all', 'yes'].includes(payload.favorites))
      && Number.isSafeInteger(payload.page) && payload.page >= 1 && payload.page <= 1000;
  }
  if (command === 'catalogue.candidates') return typeof payload.localId === 'string' && /^[a-f0-9]{64}$/.test(payload.localId) && Object.keys(payload).every(key => key === 'localId');
  if (command === 'catalogue.open') return typeof payload.chartId === 'string' && /^[A-Za-z0-9:._-]{1,512}$/.test(payload.chartId) && Object.keys(payload).every(key => key === 'chartId');
  if (command === 'catalogue.link' || command === 'catalogue.unlink') return typeof payload.localId === 'string' && /^[a-f0-9]{64}$/.test(payload.localId)
    && typeof payload.contextId === 'string' && /^[a-f0-9]{32}$/.test(payload.contextId)
    && (command === 'catalogue.unlink' || (typeof payload.chartId === 'string' && /^[A-Za-z0-9:._-]{1,512}$/.test(payload.chartId)))
    && Object.keys(payload).every(key => ['localId', 'contextId', ...(command === 'catalogue.link' ? ['chartId'] : [])].includes(key));
  if (command === 'library.scan') return ['full','quick'].includes(payload.mode) && Object.keys(payload).every(key => key === 'mode');
  if (command === 'library.prepareCleanup') return typeof payload.contextId === 'string' && /^[a-f0-9]{32}$/.test(payload.contextId)
    && typeof payload.keepId === 'string' && /^[a-f0-9]{64}$/.test(payload.keepId)
    && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && Object.keys(payload).every(key => ['contextId', 'revision', 'keepId'].includes(key));
  if (command === 'library.recycleDuplicates') return typeof payload.planId === 'string' && /^[a-f0-9]{32}$/.test(payload.planId)
    && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && Array.isArray(payload.ids) && payload.ids.length > 0
    && payload.ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) && new Set(payload.ids).size === payload.ids.length
    && Object.keys(payload).every(key => ['planId', 'revision', 'ids'].includes(key));
  if (command === 'library.forceRecycleDuplicate') return typeof payload.planId === 'string' && /^[a-f0-9]{32}$/.test(payload.planId)
    && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && typeof payload.id === 'string' && /^[a-f0-9]{64}$/.test(payload.id)
    && Object.keys(payload).every(key => ['planId', 'revision', 'id'].includes(key));
  if (command === 'library.compareDuplicates') return typeof payload.id === 'string' && /^[a-f0-9]{64}$/.test(payload.id)
    && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && Object.keys(payload).every(key => ['id', 'revision'].includes(key));
  if (command === 'library.chooseDuplicate') return typeof payload.contextId === 'string' && /^[a-f0-9]{32}$/.test(payload.contextId)
    && (payload.id === null || (typeof payload.id === 'string' && /^[a-f0-9]{64}$/.test(payload.id)))
    && Number.isSafeInteger(payload.revision) && payload.revision >= 0 && Object.keys(payload).every(key => ['id', 'revision', 'contextId'].includes(key));
  if (command === 'library.settings') return typeof payload.watch === 'boolean' && typeof payload.refreshOnStart === 'boolean' && Object.keys(payload).every(key => ['watch','refreshOnStart'].includes(key));
  if (command === 'library.query') return typeof payload.query === 'string' && payload.query.length <= 200 && ['title','artist','charter'].includes(payload.sort)
    && Number.isSafeInteger(payload.offset) && payload.offset >= 0
    && Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 100
    && (payload.audio === undefined || ['all','missing','present','unknown'].includes(payload.audio))
    && (payload.duplicates === undefined || ['all','possible'].includes(payload.duplicates))
    && Object.keys(payload).every(key => ['query','sort','offset','limit','audio','duplicates'].includes(key));
  if (command === 'library.openFolder') return typeof payload.id === 'string' && /^[a-f0-9]{64}$/.test(payload.id) && Object.keys(payload).every(key => key === 'id');
  if (command === 'mock.state') return ['idle','menu','loading','playing','paused','results'].includes(payload.state);
  if (command === 'widget.enabled') return typeof payload.id === 'string' && widgetIds.includes(payload.id) && typeof payload.enabled === 'boolean';
  if (command === 'overlay.enabled') return typeof payload.enabled === 'boolean';
  if (command === 'stream.enabled') return typeof payload.enabled === 'boolean' && Object.keys(payload).every(key => key === 'enabled');
  if (command === 'stream.settings') return Number.isSafeInteger(payload.revision) && payload.revision >= 0
    && !!payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
    && Object.keys(payload).every(key => key === 'revision' || key === 'settings')
    && Object.keys(payload.settings).every(key => ['port','canvas','layout'].includes(key));
  if (['theme.preset', 'theme.color', 'theme.effects', 'widget.appearance'].includes(command)) {
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) return false;
    if (command === 'theme.preset') return ['chartshub','dark','light','neon','cyberpunk','retro','transparent','high-contrast'].includes(payload.id);
    if (command === 'theme.color') return ['primary','secondary','accent','text','mutedText','background','border','progress','glow','shadow'].includes(payload.token) && typeof payload.color === 'string' && payload.color.length <= 128;
    if (command === 'theme.effects') return !!payload.effects && typeof payload.effects === 'object' && !Array.isArray(payload.effects) && Object.keys(payload.effects).every(key => key === 'glow' || key === 'gradient');
    return widgetIds.includes(payload.id) && !!payload.style && typeof payload.style === 'object' && !Array.isArray(payload.style)
      && Object.keys(payload.style).every(key => ['colorMode','color','fontSize','fontWeight','backgroundColor','borderColor','glow','gradient','useSourceColors'].includes(key));
  }
  if (command === 'widget.layout') {
    if (payload.destination !== undefined && payload.destination !== 'game' && payload.destination !== 'stream') return false;
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > Math.min(100, widgetIds.length)) return false;
    const ids = new Set();
    return payload.items.every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !widgetIds.includes(item.id) || ids.has(item.id)) return false;
      ids.add(item.id);
      if (Object.keys(item).some(key => !['id', 'x', 'y', 'width', 'height'].includes(key))) return false;
      if (![item.x, item.y, item.width, item.height].every(value => typeof value === 'number' && Number.isFinite(value))) return false;
      return item.x >= 0 && item.y >= 0 && item.width >= 24 && item.height >= 16 && item.x + item.width <= 1280 && item.y + item.height <= 720;
    });
  }
  if (command === 'widget.visibility') {
    return Number.isSafeInteger(payload.revision) && payload.revision >= 0 && widgetIds.includes(payload.id) && typeof payload.game === 'boolean'
      && (payload.stream === undefined || typeof payload.stream === 'boolean')
      && Array.isArray(payload.gameplayVisibility) && payload.gameplayVisibility.length <= 2
      && new Set(payload.gameplayVisibility).size === payload.gameplayVisibility.length
      && payload.gameplayVisibility.every(state => state === 'playing' || state === 'paused');
  }
  return false;
}
module.exports = { assetPath, trustedSender, trustedContentsSender, trustedFiltersWidgetCommand, trustedCatalogueWidgetCommand, validCommand };
