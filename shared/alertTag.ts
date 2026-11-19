import type { InstrumentId } from './instruments.js';

/**
 * 到价通知的唯一标识：页面内 Notification 与 Service Worker 推送共用。
 * 按品种（而非价格）生成，保证同一轮穿越被两条链路分别触发时只保留一条通知。
 */
export function alertTag(id: InstrumentId): string {
  return `goldwatch-${id}`;
}
