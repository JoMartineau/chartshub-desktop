export const ACCURACY_FIELDS = Object.freeze(['lastOffsetMs', 'meanOffsetMs', 'meanAbsoluteOffsetMs', 'standardDeviationMs', 'withinWindowPercent', 'sampleCount'] as const);
export type AccuracyField = typeof ACCURACY_FIELDS[number];
export interface AccuracyConfig { fields: AccuracyField[]; showTitle: boolean; showCoverage: boolean; }

/** One strict schema for storage, profiles, IPC and the public OBS projection. */
export function validateAccuracyConfig(value: unknown): AccuracyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Accuracy configuration');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !['fields', 'showTitle', 'showCoverage'].includes(key))) throw Error('Unknown Accuracy setting');
  if (source.fields !== undefined && (!Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > ACCURACY_FIELDS.length || new Set(source.fields).size !== source.fields.length || Array.from(source.fields).some(field => !ACCURACY_FIELDS.includes(field as AccuracyField)))) throw Error('Invalid Accuracy fields');
  for (const key of ['showTitle', 'showCoverage']) if (source[key] !== undefined && typeof source[key] !== 'boolean') throw Error('Invalid Accuracy label setting');
  // Empty v0.14.31 configs remain compatible and expose all six measurements.
  const selected = source.fields as AccuracyField[] | undefined;
  return { fields: ACCURACY_FIELDS.filter(field => !selected || selected.includes(field)), showTitle: source.showTitle !== false, showCoverage: source.showCoverage !== false };
}
