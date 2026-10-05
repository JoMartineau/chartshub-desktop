import { createDefaultRegistry } from '../dist/widgets/core/index.js';
import { WidgetRenderer } from '../dist/widgets/engine/WidgetRenderer.js';
import { GameOverlay } from '../dist/overlay/game/GameOverlay.js';
import { WidgetSettings } from '../dist/settings/WidgetSettings.js';
import { WidgetBuilder } from '../dist/builder/WidgetBuilder.js';
import { ThemeControls } from '../dist/settings/ThemeControls.js';
import { StreamControls } from '../dist/settings/StreamControls.js';
import { StreamRenderer } from '../dist/overlay/stream/StreamRenderer.js';
import { LibraryControls } from '../dist/settings/LibraryControls.js';
import { CatalogueControls } from '../dist/settings/CatalogueControls.js';
import { DownloadsControls } from '../dist/settings/DownloadsControls.js';
import { FiltersControls } from './filters-controls.js';
import { ReShadeControls } from './reshade-controls.js';
import { ReShadeSetupControls } from './reshade-setup-controls.js';
import { ProfileControls } from '../dist/settings/ProfileControls.js';

const api = window.ChartsHubCompanion;
const query = selector => document.querySelector(selector);
const ui = value => window.ChartshubCompanionLanguage?.translate?.(value) ?? value;
const controls = {
  state: query('#gameplay-state'), next: query('#step-mock'), reset: query('#reset-mock'),
  overlay: query('#overlay-enabled'), feedback: query('#action-feedback'),
};
const names = { idle: 'Inactif', menu: 'Menu', loading: 'Chargement', playing: 'En jeu', paused: 'En pause', results: 'Résultats' };
let currentSnapshot;
let receivedSnapshot = false;
let unsubscribe = () => {};
let disposed = false;
let sourceBusy = false;

const renderer = new WidgetRenderer(createDefaultRegistry(), () => {
  showError('Un widget n’a pas pu s’afficher. Les autres informations restent disponibles.');
});
const overlay = new GameOverlay(query('#game-preview'), renderer);
const streamPreview = new StreamRenderer(query('#stream-preview'), new WidgetRenderer(createDefaultRegistry(), () => {
  showError('Un widget Stream n’a pas pu s’afficher. Les autres informations restent disponibles.');
}));
const themePreview = new GameOverlay(query('#theme-preview'), new WidgetRenderer(createDefaultRegistry()));
const settings = new WidgetSettings(query('#widget-settings'), (id, enabled) => {
  void command('widget.enabled', { id, enabled });
}, payload => command('widget.fontSize', payload));
const builder = new WidgetBuilder({
  root: query('#companion-app'),
  surface: query('.preview-surface'),
  renderPreview: (state, destination) => {
    syncPreviewDestination(destination, state.stream?.canvas);
    if (destination === 'stream') streamPreview.render(state); else overlay.render(state);
    updatePreviewStatus();
  },
  command: (name, payload) => command(name, payload),
});
const themes = new ThemeControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
const stream = new StreamControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
const library = new LibraryControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
const catalogue = new CatalogueControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
const downloads = new DownloadsControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
const filters = new FiltersControls({ root: query('#filters-classic-controls'), focusRoot: query('#game-filters'), command: (name, payload) => command(name, payload) });
const reshade = new ReShadeControls({ root: query('#reshade-controls'), command: (name, payload) => command(name, payload) });
const reshadeSetup = new ReShadeSetupControls({ root: query('#reshade-controls'), command: (name, payload) => command(name, payload) });
const profiles = new ProfileControls({ root: query('#companion-app'), command: (name, payload) => command(name, payload) });
query('#companion-app').addEventListener('companion:catalogue-candidates', event => {
  if (typeof event.detail?.localId === 'string') catalogue.showCandidates(event.detail.localId);
});

function showError(message) {
  controls.feedback.textContent = message;
  controls.feedback.hidden = false;
}

function liveSource(snapshot = currentSnapshot) {
  return snapshot?.cloneHero?.mode === 'live';
}

function exportedSong(snapshot = currentSnapshot) {
  return Boolean(snapshot?.state?.gameplay?.isChartActive && snapshot.state.nowPlaying);
}

function renderSource(snapshot) {
  const live = liveSource(snapshot), source = snapshot?.cloneHero;
  query('#clonehero-mode').value = live ? 'live' : 'mock';
  query('#clonehero-mode').disabled = sourceBusy || !source || !api;
  for (const id of ['#clonehero-choose-file', '#clonehero-detect']) query(id).disabled = sourceBusy || !source || !live || !api;
  query('#clonehero-live-controls').hidden = !live;
  query('#clonehero-capabilities').hidden = !live;
  query('#source-mode-label').textContent = live ? 'DIRECT CLONE HERO' : 'MODE DÉMO';
  query('#source-mode-badge').classList.toggle('is-live', live);
  document.body.dataset.cloneheroMode = live ? 'live' : 'mock';
  const path = query('#clonehero-file-path');
  path.textContent = source?.filePath || 'Aucun fichier sélectionné';
  path.title = source?.filePath || '';
  const sourceIssue = { unsupported: 'Format d’export non pris en charge', error: 'Lecture de l’export indisponible', missing: 'Fichier currentsong.txt introuvable' }[source?.status];
  query('#clonehero-status').textContent = live
    ? sourceIssue || (exportedSong(snapshot) ? 'Morceau exporté · lecture/pause indéterminée' : 'En attente d’un morceau')
    : 'Démonstration locale';
  query('.clonehero-diagnostic').dataset.status = source?.status || 'mock';
  query('#clonehero-message').textContent = typeof source?.message === 'string' && source.message
    ? source.message
    : live ? 'Sélectionnez currentsong.txt. Le morceau en cours sera repris si Clone Hero est détecté.' : 'Le scénario ci-dessous simule les étapes d’une chart.';
  query('#simulation-panel').hidden = live;
  for (const control of [controls.next, controls.reset, controls.state]) {
    control.hidden = live;
    control.disabled = live || sourceBusy || !api;
  }
  query('#behavior-visible').textContent = live ? 'Affichage du morceau exporté par Clone Hero.' : 'Visible en jeu et en pause.';
  query('#behavior-hidden').textContent = live ? 'La lecture, la pause et les menus ne sont pas détectés.' : 'Masqué au menu, au chargement et aux résultats.';
  query('#integration-note-title').textContent = live ? 'Export natif Clone Hero' : 'Source Clone Hero simulée';
  query('#integration-note-description').textContent = live
    ? 'Le titre, l’artiste et le créateur proviennent de currentsong.txt. L’instrument, la difficulté et l’état exact du jeu ne sont pas fournis.'
    : 'La démonstration utilise un scénario local. Choisissez Direct Clone Hero pour lire les informations exportées par le jeu.';
  query('#connection-status').textContent = live ? 'Source : export natif Clone Hero · lecture et pause indéterminées' : 'Source : Mock Clone Hero · Démonstration locale';
}

async function changeSource(name, payload) {
  if (sourceBusy || !api || disposed) return;
  sourceBusy = true;
  query('#clonehero-feedback').hidden = true;
  renderSource(currentSnapshot);
  try {
    const result = await command(name, payload);
    if (!result?.ok && !disposed) {
      query('#clonehero-feedback').textContent = result?.error || 'La source Clone Hero n’a pas pu être mise à jour. Réessayez.';
      query('#clonehero-feedback').hidden = false;
    }
  } finally {
    sourceBusy = false;
    if (!disposed) renderSource(currentSnapshot);
  }
}

function applySnapshot(snapshot) {
  if (disposed || !snapshot?.state) return;
  if (snapshot.language === 'fr' || snapshot.language === 'en') window.ChartshubCompanionLanguage?.apply(snapshot.language);
  currentSnapshot = snapshot;
  receivedSnapshot = true;
  const { state } = snapshot;
  const gameplay = state.gameplay.state;
  controls.state.value = gameplay;
  controls.overlay.checked = snapshot.overlayEnabled;
  const badge = query('#gameplay-badge');
  badge.textContent = liveSource(snapshot) ? exportedSong(snapshot) ? 'Morceau exporté' : 'En attente' : names[gameplay] ?? 'Inactif';
  badge.dataset.state = gameplay;
  document.body.dataset.gameplayState = gameplay;
  renderSource(snapshot);
  query('#overlay-status').textContent = snapshot.overlayEnabled ? 'Fenêtre overlay activée' : 'Fenêtre overlay désactivée';
  for (const item of document.querySelectorAll('[data-scenario-state]')) {
    const active = item.dataset.scenarioState === gameplay;
    item.classList.toggle('is-current', active);
    if (active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  settings.render(state.widgets.instances, snapshot.editor?.revision ?? 0);
  overlay.render(state);
  streamPreview.render(state);
  builder.update(snapshot);
  themes.update(snapshot);
  stream.update(snapshot);
  library.update(snapshot);
  catalogue.update(snapshot);
  downloads.update(snapshot);
  filters.update(snapshot);
  reshade.update(snapshot);
  reshadeSetup.update(snapshot);
  profiles.update(snapshot);
  themePreview.render({
    ...state,
    gameplay: { state: 'playing', isChartActive: true },
    nowPlaying: state.nowPlaying ?? { songId: 'theme-preview', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' },
    widgets: { ...state.widgets, instances: state.widgets.instances.map(instance => ({ ...instance, enabled: true, visibility: { ...instance.visibility, game: true }, gameplayVisibility: ['playing', 'paused'] })) },
  });
  query('#persistence-feedback').hidden = !snapshot.persistenceError;
  query('#persistence-feedback').textContent = snapshot.persistenceError
    ? 'Les réglages n’ont pas pu être enregistrés. Vos changements restent actifs pendant cette session.' : '';
  query('#settings-status').textContent = snapshot.persistenceError ? 'Enregistrement indisponible' : 'Réglages enregistrés automatiquement';
  window.ChartshubCompanionLanguage?.refresh();
}

function updatePreviewStatus() {
  if (!currentSnapshot) return;
  const gameplay = currentSnapshot.state.gameplay.state;
  const live = liveSource();
  const destination = builder.destination;
  const visible = query(`#${destination}-preview`).querySelector('.companion-widget') !== null;
  const streamWidgets = currentSnapshot.state.widgets.instances.some(instance => instance.enabled && instance.visibility.stream && (instance.gameplayVisibility ?? ['playing', 'paused']).length > 0);
  const visibility = query('#visibility-status');
  visibility.textContent = builder.enabled ? 'Édition' : visible ? 'Visible' : 'Masqué';
  visibility.classList.toggle('is-visible', visible);
  query('#preview-empty').hidden = builder.enabled || visible;
  const active = live ? exportedSong() : gameplay === 'playing' || gameplay === 'paused';
  query('#preview-empty strong').textContent = destination === 'stream' && !streamWidgets ? 'Aucun widget activé pour le Stream' : active ? 'Aucun widget à afficher' : live ? 'En attente d’un morceau' : 'Now Playing est masqué';
  query('#preview-empty-description').textContent = destination === 'stream' && !streamWidgets
    ? 'Activez des éléments dans la section Stream / OBS ci-dessous.'
    : live
      ? active ? 'Activez le titre, l’artiste ou le créateur. L’export ne fournit pas l’instrument ni la difficulté.' : 'Consultez le diagnostic de la source ci-dessus pour connecter Clone Hero ou recevoir un nouvel export.'
    : active
    ? 'Activez un widget dont les informations sont disponibles.'
    : gameplay === 'results'
      ? 'La chart est terminée. Les informations du morceau sont masquées.'
      : 'Le morceau apparaîtra en jeu et restera visible en pause.';
  query('#preview-context').textContent = builder.enabled
    ? live
      ? `Disposition ${destination === 'stream' ? 'Stream' : 'Jeu'} · Édition locale ; données de démonstration en l’absence de morceau exporté.`
      : `Disposition ${destination === 'stream' ? 'Stream' : 'Jeu'} · Aperçu local de démonstration hors chart. Les cadres ne changent pas la police.`
    : live
    ? active ? 'Morceau exporté · lecture/pause indéterminée' : 'En attente d’un morceau · consultez le diagnostic de la source.'
    : gameplay === 'paused'
    ? 'La chart est en pause. Les informations restent visibles.'
    : gameplay === 'playing'
      ? 'Une chart est active. Les widgets suivent vos réglages.'
      : 'L’overlay apparaît pendant une chart et reste visible en pause.';
  query('#overlay-status').textContent = destination === 'stream'
    ? currentSnapshot.stream?.enabled ? 'Serveur Stream actif' : 'Serveur Stream arrêté'
    : currentSnapshot.overlayEnabled ? 'Fenêtre overlay activée' : 'Fenêtre overlay désactivée';
}

function syncPreviewDestination(destination, canvas) {
  const streaming = destination === 'stream';
  query('#game-preview').hidden = streaming;
  query('#stream-preview').hidden = !streaming;
  for (const target of ['game', 'stream']) {
    const selected = target === destination;
    const tab = query(`#preview-${target}-tab`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const surface = query('.preview-surface');
  const width = canvas?.width ?? 1920;
  const height = canvas?.height ?? 1080;
  const ratio = streaming ? width / height : 16 / 9;
  surface.style.aspectRatio = String(ratio);
  surface.style.width = streaming ? `min(100%, ${ratio * 480}px)` : '100%';
  surface.classList.toggle('is-stream-preview', streaming);
  query('#preview-screen-label').textContent = streaming ? 'CANVAS STREAM · FOND TRANSPARENT' : 'ÉCRAN DE JEU';
  query('#preview-canvas-caption').textContent = streaming
    ? `Stream · ${width.toLocaleString(document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US')} × ${height.toLocaleString(document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US')} · ${canvas?.fps ?? 60} i/s`
    : 'Jeu · 1 280 × 720';
  document.body.dataset.previewDestination = destination;
}

function selectPreview(destination) {
  builder.setDestination(destination);
  syncPreviewDestination(builder.destination, currentSnapshot?.state.stream?.canvas);
  updatePreviewStatus();
}

async function command(name, payload, control) {
  if (!api) return;
  const libraryQuery = name === 'library.query';
  const catalogueCommand = name.startsWith('catalogue.');
  const downloadsCommand = name.startsWith('downloads.');
  const sourceCommand = name.startsWith('clonehero.');
  const profileCommand = name.startsWith('profile.');
  const filtersCommand = name.startsWith('filters.') || name.startsWith('reshade.');
  if (!libraryQuery && !catalogueCommand && !downloadsCommand && !sourceCommand && !filtersCommand && !profileCommand) controls.feedback.hidden = true;
  if (control) control.disabled = true;
  try {
    const result = await api.command(name, payload);
    if (catalogueCommand || downloadsCommand || sourceCommand || filtersCommand || profileCommand) {
      applySnapshot(result?.snapshot ?? await api.getSnapshot());
      return result;
    }
    if (libraryQuery) {
      if (result?.snapshot) applySnapshot(result.snapshot);
      else if (result?.ok && result.result?.revision > (currentSnapshot?.library?.revision ?? -1)) applySnapshot(await api.getSnapshot());
      return result;
    }
    if (!result?.ok) showError('Cette action n’a pas pu être appliquée. Réessayez.');
    applySnapshot(result?.snapshot ?? await api.getSnapshot());
    return result;
  } catch {
    if (libraryQuery || catalogueCommand || downloadsCommand || sourceCommand || filtersCommand || profileCommand) return { ok: false };
    showError('Le Companion ne répond pas à cette action. Réessayez dans un instant.');
    if (currentSnapshot) applySnapshot(currentSnapshot);
  } finally {
    if (control) control.disabled = [controls.next, controls.reset, controls.state].includes(control) && (liveSource() || sourceBusy);
  }
}

controls.next.addEventListener('click', () => { void command('mock.next', undefined, controls.next); });
controls.reset.addEventListener('click', () => { void command('mock.reset', undefined, controls.reset); });
controls.state.addEventListener('change', () => { void command('mock.state', { state: controls.state.value }, controls.state); });
controls.overlay.addEventListener('change', () => { void command('overlay.enabled', { enabled: controls.overlay.checked }, controls.overlay); });
query('#clonehero-mode').addEventListener('change', event => { void changeSource('clonehero.mode', { mode: event.target.value }); });
query('#clonehero-choose-file').addEventListener('click', () => { void changeSource('clonehero.chooseFile'); });
query('#clonehero-detect').addEventListener('click', () => { void changeSource('clonehero.detect'); });
for (const destination of ['game', 'stream']) {
  const tab = query(`#preview-${destination}-tab`);
  tab.addEventListener('click', () => selectPreview(destination));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.key === 'Home' ? 'game' : event.key === 'End' ? 'stream' : destination === 'game' ? 'stream' : 'game';
    selectPreview(target);
    query(`#preview-${builder.destination}-tab`).focus({ preventScroll: true });
  });
}

async function connect() {
  if (!api) {
    showError('Ouvrez le Companion depuis ChartsHub pour utiliser la démonstration et l’overlay.');
    query('#connection-status').textContent = 'Connexion à ChartsHub indisponible';
    for (const control of [controls.next, controls.reset, controls.state, controls.overlay, query('#builder-toggle')]) control.disabled = true;
    return;
  }
  try {
    unsubscribe = api.subscribe(applySnapshot);
    const initial = await api.getSnapshot();
    if (!receivedSnapshot) applySnapshot(initial);
  } catch {
    showError('Le Companion n’a pas pu charger son état. Fermez puis rouvrez ce panneau.');
    query('#connection-status').textContent = 'Chargement du Companion indisponible';
  }
}

window.addEventListener('beforeunload', () => {
  disposed = true;
  unsubscribe();
  overlay.dispose();
  settings.dispose();
  builder.dispose();
  themes.dispose();
  themePreview.dispose();
  stream.dispose();
  streamPreview.dispose();
  library.dispose();
  catalogue.dispose();
  downloads.dispose();
  filters.dispose();
  reshade.dispose();
  reshadeSetup.dispose();
  profiles.dispose();
}, { once: true });

void connect();
