import type { InstrumentId } from './instruments.js';

/** Web Push 订阅者在 Worker KV 中的存储结构 */
export interface PushSubscriptionRecord {
  /** 浏览器推送端点 URL */
  endpoint: string;
  /** P-256 公钥（base64url） */
  p256dh: string;
  /** 鉴权密钥（base64url） */
  auth: string;
  /** 用户设置的目标区间（Worker 端也存一份，用于 Cron 到价检测） */
  targets: Record<InstrumentId, { low: number | null; high: number | null; enabled: boolean }>;
  /** Worker 端维护的到价运行态（避免与前端重复触发） */
  runtime: Record<InstrumentId, { zone: 'inside' | 'outside'; lastTriggeredAt: number }>;
  /** 订阅创建时间 */
  createdAt: number;
  /** 最近一次同步 targets 的时间 */
  updatedAt: number;
}

/** 前端上报的 targets（与前端 storage.ts 的 TargetRange 一致，但 Worker 不需要带 React 类型） */
export type PushTargetRange = { low: number | null; high: number | null; enabled: boolean };
export type PushTargets = Record<InstrumentId, PushTargetRange>;
