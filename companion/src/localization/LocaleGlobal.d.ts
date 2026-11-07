interface ChartsHubLocaleRuntime {
  canonicalize(value: unknown): string | null;
  negotiate(value: string | readonly string[]): string;
  definition(value: string): { code: string; dir: string; intl: string; label: string } | null;
  format(source: string, values?: Record<string, unknown>): string;
}
interface ChartsHubDesktopLocaleContext {
  get(): string;
  set(value: unknown): string;
  t(source: string, values?: Record<string, unknown>, locale?: string): string;
  pair(fr: string, en: string, values?: Record<string, unknown>, locale?: string): string;
  dictionary<T>(fr: T, en: T, locale?: string): T;
  ready(): Promise<void>;
  intl(): string;
  direction(): string;
  runtime: ChartsHubLocaleRuntime;
}
declare var ChartshubDesktopLocale: ChartsHubDesktopLocaleContext | undefined;
