/** Shared UI names. The Companion localization layer translates these French labels. */
const labels: Record<string, string> = {
  'song.title': 'Titre du morceau', 'song.artist': 'Artiste', 'song.charter': 'Créateur de la chart',
  'song.instrument': 'Instrument', 'song.difficulty': 'Difficulté',
  'gameplay.accuracy': 'Accuracy · précision', 'gameplay.combo': 'Combo et record de session',
  'gameplay.fc': 'Suivi FC', 'gameplay.progress': 'Progression du morceau',
  'gameplay.comparison': 'Comparaison du meilleur score', 'session.goal': 'Objectif de session',
  'session.history': 'Cinq derniers essais',
};
export const widgetLabel = (type: string): string => labels[type] ?? type;
