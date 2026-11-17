import type { InstrumentId } from '../../shared/instruments';
import type { QuoteSource } from '../../shared/types';

const priceFormatterCache = new Map<string, Intl.NumberFormat>();

function priceFormatter(decimals: number): Intl.NumberFormat {
  const key = `p${decimals}`;
  let formatter = priceFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    priceFormatterCache.set(key, formatter);
  }
  return formatter;
}

export function formatPrice(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return priceFormatter(decimals).format(value);
}

export function splitPrice(
  value: number | null | undefined,
  decimals = 2,
): { int: string; frac: string } {
  const formatted = formatPrice(value, decimals);
  if (formatted === '—') return { int: '—', frac: '' };
  const dot = formatted.lastIndexOf('.');
  if (dot === -1) return { int: formatted, frac: '' };
  return { int: formatted.slice(0, dot), frac: formatted.slice(dot + 1) };
}

export function formatSigned(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${priceFormatter(decimals).format(Math.abs(value))}`;
}

export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(decimals)}%`;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const shortTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return timeFormatter.format(timestamp);
}

export function formatShortTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return shortTimeFormatter.format(timestamp);
}

const logTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatLogTime(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const sameDay =
    new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(now) ===
    new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(date);
  if (sameDay) return timeFormatter.format(timestamp);
  return logTimeFormatter.format(timestamp);
}

export function formatRangeLabel(
  low: number | null,
  high: number | null,
  decimals = 2,
): string {
  if (low !== null && high !== null) return `${formatPrice(low, decimals)} – ${formatPrice(high, decimals)}`;
  if (high !== null) return `≤ ${formatPrice(high, decimals)}`;
  if (low !== null) return `≥ ${formatPrice(low, decimals)}`;
  return '未设置';
}

export function formatMarketDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(timestamp);
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(timestamp);
  return `${month}月${day}日 · ${weekday}`;
}

export const SOURCE_LABEL: Record<QuoteSource, string> = {
  sina: '新浪财经',
  eastmoney: '东方财富',
  jd: '京东金融',
  'gold-api': 'gold-api.com',
  derived: '汇率参考换算',
};

/** 数据来源徽标对应的官方行情页，用于点击跳转核对数据 */
const SOURCE_LINKS: Partial<Record<QuoteSource, Partial<Record<InstrumentId, string>>>> = {
  sina: {
    xauusd: 'https://gu.sina.cn/ft/hq/hf.php?symbol=XAU',
    // 新浪没有 AU9999/AUTD 独立行情页，跳转到上金所官方行情核对
    au9999: 'https://www.sge.com.cn/sjzx/mrhq',
    autd: 'https://www.sge.com.cn/sjzx/mrhq',
  },
  eastmoney: {
    xauusd: 'https://quote.eastmoney.com/unify/r/122.XAU',
    au9999: 'https://quote.eastmoney.com/unify/r/118.AU9999',
    autd: 'https://quote.eastmoney.com/unify/r/118.AUTD',
  },
  jd: {
    zsjcg: 'https://m.jdjygold.com/finance-gold/newgold/',
  },
  'gold-api': {
    xauusd: 'https://gold-api.com/',
  },
};

export function sourceLink(source: QuoteSource, instrument: InstrumentId): string | undefined {
  return SOURCE_LINKS[source]?.[instrument];
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
