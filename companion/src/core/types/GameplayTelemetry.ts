export interface TimingMetrics {
  lastOffsetMs: number | null;
  meanOffsetMs: number | null;
  meanAbsoluteOffsetMs: number | null;
  standardDeviationMs: number | null;
  withinWindowPercent: number | null;
  windowMs: number;
  sampleCount: number;
  coverage: 'complete' | 'since-connect' | 'incomplete';
}
export interface GameplayTelemetry {
  connected: boolean;
  status: 'disabled' | 'waiting' | 'connecting' | 'connected' | 'unsupported' | 'stale' | 'error';
  language?: 'fr' | 'en';
  gameVersion: string | null;
  capabilities: Record<'hitTiming' | 'combo' | 'clock' | 'score' | 'misses' | 'overstrums' | 'attemptResults' | 'songIdentity' | 'songMetadata' | 'calibrationTiming' | 'calibrationResults', boolean>;
  phase: 'idle' | 'menu' | 'loading' | 'playing' | 'paused' | 'results';
  active: {
    metadata: { title?: string; artist?: string; charter?: string; instrument?: string; difficulty?: string };
    stats: { score: number | null; combo: number | null; misses: number | null; overstrums: number | null; notesHit: number | null; notesTotal: number | null };
    clock: { positionSeconds: number; durationSeconds: number; speed?: number } | null;
    ended: boolean;
    completed: boolean | null;
    coverage: 'complete' | 'since-connect' | 'incomplete';
  } | null;
  timing: TimingMetrics;
  hasChartIdentity?: boolean;
  comparison: { bestScore: number | null; personalBestScore: number | null; currentScore: number | null; delta: number | null; bestAttempt?: {notesHit:number;notesTotal:number;misses:number;overstrums:number} | null };
  session: { completedSongs: number; fullCombos: number; bestCombo: number; durationSeconds: number };
  goal: { kind: 'songs' | 'fc' | 'minutes'; target: number; value: number; percent: number };
  history: { title: string | null; artist: string | null; score: number | null; fullCombo: boolean | null; completed: boolean; coverage: 'complete' | 'since-connect' | 'incomplete'; meanAbsoluteOffsetMs: number | null; sampleCount: number; at: number }[];
}
