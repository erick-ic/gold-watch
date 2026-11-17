import type { InstrumentId } from './instruments.js';
import type { MarketSession } from './types.js';

const BEIJING = 'Asia/Shanghai';
const NEW_YORK = 'America/New_York';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zoneClock(timeZone: string, at: number): { day: number; minutes: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return { day: WEEKDAYS.indexOf(weekday), minutes: hour * 60 + minute };
}

export function getMarketSession(id: InstrumentId, at = Date.now()): MarketSession {
  if (id === 'xauusd') return londonSession(at);
  if (id === 'zsjcg') return bankGoldSession(at);
  return sgeSession(at);
}

/**
 * 上金所（北京时间）：日盘 09:00–11:30、13:30–15:30，夜盘 20:00–次日 02:30。
 * 周五无夜盘，周末休市；法定节假日以交易所公告为准。
 */
export function sgeSession(at: number): MarketSession {
  const { day, minutes } = zoneClock(BEIJING, at);

  if (day === 0 || day === 6) {
    return closed('休市', '下周一 09:00 开盘');
  }
  if (minutes >= 540 && minutes < 690) {
    return open('交易中', '日盘 09:00–15:30');
  }
  if (minutes >= 810 && minutes < 930) {
    return open('交易中', '日盘 09:00–15:30');
  }
  if (minutes >= 690 && minutes < 810) {
    return { phase: 'break', label: '午间休市', detail: '13:30 恢复交易' };
  }
  if (minutes >= 1200) {
    if (day === 5) return closed('已收盘', '下周一 09:00 开盘');
    return open('交易中', '夜盘 20:00–次日 02:30');
  }
  if (minutes >= 930 && minutes < 1200) {
    return day === 5
      ? closed('已收盘', '下周一 09:00 开盘')
      : closed('已收盘', '夜盘 20:00 开始');
  }
  if (minutes < 150) {
    if (day === 1) return closed('休市', '今日 09:00 开盘');
    return open('交易中', '夜盘 20:00–次日 02:30');
  }
  if (day === 1) return closed('休市', '今日 09:00 开盘');
  return closed('已收盘', '今日 09:00 开盘');
}

/**
 * 伦敦金按纽约交易时段计算，自动适配夏令时：
 * 周日 18:00 开盘至周五 17:00 收盘，周一至周四 17:00–18:00 结算暂停。
 */
export function londonSession(at: number): MarketSession {
  const { day, minutes } = zoneClock(NEW_YORK, at);

  if (day === 0) {
    return minutes >= 1080
      ? open('交易中', '每日约 1 小时结算暂停')
      : closed('休市', '周一开盘后恢复');
  }
  if (day === 6) {
    return closed('休市', '周一开盘后恢复');
  }
  if (day === 5) {
    return minutes >= 1020
      ? closed('休市', '周一开盘后恢复')
      : open('交易中', '每日约 1 小时结算暂停');
  }
  if (minutes >= 1020 && minutes < 1080) {
    return { phase: 'break', label: '结算暂停', detail: '约 1 小时后恢复交易' };
  }
  return open('交易中', '每日约 1 小时结算暂停');
}

/**
 * 银行积存金（北京时间）：工作日 24 小时交易，每日 23:50–00:10 系统清算，
 * 周五 23:50 后至下周一 00:10 休市。节假日以银行公告为准。
 */
export function bankGoldSession(at: number): MarketSession {
  const { day, minutes } = zoneClock(BEIJING, at);

  if (day === 0 || day === 6) {
    return closed('休市', '周一 00:10 开盘');
  }
  if (minutes >= 1430) {
    return day === 5
      ? closed('休市', '周一 00:10 开盘')
      : { phase: 'break', label: '系统清算', detail: '00:10 恢复交易' };
  }
  if (minutes < 10) {
    return { phase: 'break', label: '系统清算', detail: '00:10 恢复交易' };
  }
  return open('交易中', '24 小时交易，每日 23:50–00:10 清算');
}

function open(label: string, detail: string): MarketSession {
  return { phase: 'open', label, detail };
}

function closed(label: string, detail: string): MarketSession {
  return { phase: 'closed', label, detail };
}
