import type { InstrumentId } from './instruments.js';

export type QuoteSource = 'sina' | 'eastmoney' | 'jd' | 'gold-api' | 'derived';

type MarketPhase = 'open' | 'break' | 'closed';

export interface MarketSession {
  phase: MarketPhase;
  /** 交易中 / 午间休市 / 结算暂停 / 已收盘 / 休市 */
  label: string;
  /** 面向用户的时段说明 */
  detail: string;
}

export interface Quote {
  id: InstrumentId;
  price: number;
  bid: number | null;
  ask: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
  /** 行情时间（epoch 毫秒），统一按北京时间解析 */
  quoteTime: number | null;
  source: QuoteSource;
  /** 由国际金价按汇率换算而来，仅供参考 */
  derived: boolean;
  /** 本轮刷新未取到新报价，沿用上一次有效值 */
  stale: boolean;
}

export interface MarketSnapshot {
  /** 服务端本轮刷新完成时间（epoch 毫秒） */
  fetchedAt: number;
  usdcny: number | null;
  quotes: Quote[];
  /** 各品种当前交易时段（北京时间） */
  sessions: Record<InstrumentId, MarketSession>;
  /** 任一品种未能取到实时报价 */
  degraded: boolean;
}

export interface HistoryPoint {
  /** epoch 毫秒 */
  t: number;
  p: number;
}

export interface HistoryResponse {
  id: InstrumentId;
  prevClose: number | null;
  points: HistoryPoint[];
  source: 'eastmoney' | 'sina' | 'sge' | 'session';
  fetchedAt: number;
  stale: boolean;
}

export interface HealthResponse {
  ok: boolean;
  uptimeSec: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  clients: number;
  sources: Record<string, number>;
}
