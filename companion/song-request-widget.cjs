'use strict';

const DEFAULT_WIDGET = Object.freeze({ accentColor: '#38bdf8', fontSize: 24, upcomingCount: 3,
  showNowPlaying: true, showViewerNames: true });
function validateWidget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== Object.keys(DEFAULT_WIDGET).length
      || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_WIDGET, key))
      || typeof value.accentColor !== 'string' || !/^#[a-f0-9]{6}$/i.test(value.accentColor)
      || !Number.isSafeInteger(value.fontSize) || value.fontSize < 16 || value.fontSize > 48
      || !Number.isSafeInteger(value.upcomingCount) || value.upcomingCount < 1 || value.upcomingCount > 10
      || typeof value.showNowPlaying !== 'boolean' || typeof value.showViewerNames !== 'boolean') {
    throw TypeError('Invalid Song Request widget settings.');
  }
  return { accentColor: value.accentColor.toLowerCase(), fontSize: value.fontSize,
    upcomingCount: value.upcomingCount, showNowPlaying: value.showNowPlaying, showViewerNames: value.showViewerNames };
}
const text = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 512) : '';
// Match the native song identity only. Shared names and titles never establish
// which viewer requested the currently playing version.
function widgetNowPlaying(value, requests, settings = DEFAULT_WIDGET) {
  if (!settings.showNowPlaying || !value || !['playing', 'exported'].includes(value.state) || !text(value.title)) return null;
  const result = { title: text(value.title), artist: text(value.artist), state: value.state };
  const songId = typeof value.songId === 'string' && /^[a-f0-9]{64}$/.test(value.songId) ? value.songId : null;
  const matches = songId && Array.isArray(requests) ? requests.filter(row => row?.songId === songId && row.status === 'accepted') : [];
  if (settings.showViewerNames && matches.length === 1 && text(matches[0].viewerName)) result.viewerName = text(matches[0].viewerName);
  return result;
}
module.exports = { DEFAULT_WIDGET, validateWidget, widgetNowPlaying };
