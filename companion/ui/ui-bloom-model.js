// Shared by the renderer and the main-process store. UI decoration only.
export const DEFAULTS = Object.freeze({ version: 1, enabled: false, color: '#a855f7', intensity: 65, radius: 4, blur: 32, opacity: 65, economy: false });
export const RANGES = Object.freeze({ intensity: Object.freeze([0, 100, '%']), radius: Object.freeze([0, 24, ' px']), blur: Object.freeze([0, 80, ' px']), opacity: Object.freeze([0, 100, '%']) });
export function color(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const match = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(value.trim());
  if (!match) return null;
  return '#' + (match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]).toLowerCase();
}
export function rgb(value) { return (color(value) || DEFAULTS.color).slice(1).match(/../g).map(c => parseInt(c, 16)); }
export function fromRGB(values) {
  return Array.isArray(values) && values.length === 3 && values.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
    ? '#' + values.map(v => v.toString(16).padStart(2, '0')).join('') : null;
}
export function normalize(value) {
  const p = value && typeof value === 'object' && !Array.isArray(value) && (value.version === undefined || value.version === 1) ? value : {};
  const out = { ...DEFAULTS, color: color(p.color) || DEFAULTS.color, enabled: p.enabled === true, economy: p.economy === true };
  for (const [key, [min, max]] of Object.entries(RANGES)) out[key] = typeof p[key] === 'number' && Number.isFinite(p[key]) ? Math.round(Math.max(min, Math.min(max, p[key]))) : DEFAULTS[key];
  return out;
}
// IPC and disk reads are strict, unlike the defensive renderer normalizer.
export function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(DEFAULTS);
  if (Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) return null;
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.economy !== 'boolean') return null;
  if (typeof value.color !== 'string' || !/^#[a-f\d]{6}$/i.test(value.color)) return null;
  if (!Object.entries(RANGES).every(([key, [min, max]]) => Number.isInteger(value[key]) && value[key] >= min && value[key] <= max)) return null;
  return normalize(value);
}
export function shadow(value) {
  const p = normalize(value);
  if (!p.enabled || !p.intensity || !p.opacity) return 'none';
  const c = rgb(p.color).join(', '), strength = p.intensity / 100, opacity = p.opacity / 100;
  const rgba = alpha => `rgba(${c}, ${Math.min(1, alpha).toFixed(3)})`;
  const blur = p.economy ? Math.min(16, p.blur) : p.blur;
  const radius = p.economy ? Math.min(3, p.radius) : p.radius;
  const soft = `0 0 ${blur}px ${radius}px ${rgba(opacity * strength * strength * .65)}`;
  return p.economy ? soft : `0 0 0 1px ${rgba(opacity * strength * .8)}, 0 0 ${Math.min(12, blur)}px ${rgba(opacity * strength * .55)}, ${soft}`;
}
