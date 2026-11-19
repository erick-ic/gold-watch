export const PORT = Number(process.env.PORT ?? 8787);
// 本地版本以实时性优先：默认 2s 拉一轮，SSE 同步推送
export const POLL_INTERVAL_MS = clamp(Number(process.env.POLL_INTERVAL_MS ?? 2000), 2000, 60_000);
export const STALE_AFTER_MS = Math.max(POLL_INTERVAL_MS * 4, 20_000);
export const QUOTE_STALE_MS = 120_000;
export const HISTORY_TTL_MS = 30_000;
export const HISTORY_MAX_POINTS = 900;
export const MAX_SSE_CLIENTS = 80;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 180;
// 报价源超时 3s：正常上游响应都在几百 ms 内，快速失败避免拖垮实时刷新
export const FETCH_TIMEOUT_MS = 3000;
// 分时历史不在实时关键路径上（服务端缓存 30s），且响应体较大，
// 走边缘节点时偶发需要数秒，给更宽的超时避免线上图表因超时变空
export const HISTORY_FETCH_TIMEOUT_MS = 8000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
