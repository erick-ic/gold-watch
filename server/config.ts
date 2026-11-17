export const PORT = Number(process.env.PORT ?? 8787);
export const POLL_INTERVAL_MS = clamp(Number(process.env.POLL_INTERVAL_MS ?? 5000), 2000, 60_000);
export const STALE_AFTER_MS = Math.max(POLL_INTERVAL_MS * 4, 20_000);
export const QUOTE_STALE_MS = 120_000;
export const HISTORY_TTL_MS = 30_000;
export const HISTORY_MAX_POINTS = 900;
export const MAX_SSE_CLIENTS = 80;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 180;
export const FETCH_TIMEOUT_MS = 8000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
