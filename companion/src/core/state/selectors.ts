import type { AppState } from './AppState.js';

export const selectGameplay = (state: AppState) => state.gameplay;
export const selectNowPlaying = (state: AppState) => state.nowPlaying;
export const selectServiceHealth = (state: AppState) => state.serviceHealth;
export const selectWidgets = (state: AppState) => state.widgets.instances;
