export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(timestamp: string, staleAfterMs: number, now = Date.now()): boolean {
  const parsed = Date.parse(timestamp);
  return !Number.isFinite(parsed) || now - parsed > staleAfterMs;
}

export function formatUpdatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? `Last updated: ${date.toLocaleString()}`
    : "Last updated: unavailable";
}
