import { INSTRUMENT_IDS, type InstrumentId } from '../../shared/instruments';
import type { TargetRange } from './alerts';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ColorMode = 'cn' | 'intl';
export type GlassMode = 'classic' | 'clear' | 'vivid' | 'solid';

export interface Settings {
  theme: ThemeMode;
  colorMode: ColorMode;
  glass: GlassMode;
  sound: boolean;
  notifications: boolean;
}

export interface AlertLogEntry {
  id: string;
  instrument: InstrumentId;
  price: number;
  low: number | null;
  high: number | null;
  at: number;
}

export interface AlertRuntime {
  zone: 'inside' | 'outside';
  lastTriggeredAt: number;
}

const SETTINGS_KEY = 'goldwatch.settings.v1';
const TARGETS_KEY = 'goldwatch.targets.v1';
const RUNTIME_KEY = 'goldwatch.alertstate.v1';
const LOG_KEY = 'goldwatch.alertlog.v1';
const SELECTED_KEY = 'goldwatch.selected.v1';

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  colorMode: 'cn',
  glass: 'clear',
  sound: true,
  notifications: true,
};

function createDefaultTargets(): Record<InstrumentId, TargetRange> {
  return Object.fromEntries(
    INSTRUMENT_IDS.map((id) => [id, { low: null, high: null, enabled: false }]),
  ) as Record<InstrumentId, TargetRange>;
}

function createDefaultRuntime(): Record<InstrumentId, AlertRuntime> {
  return Object.fromEntries(
    INSTRUMENT_IDS.map((id) => [id, { zone: 'outside', lastTriggeredAt: 0 }]),
  ) as Record<InstrumentId, AlertRuntime>;
}

export function loadSettings(): Settings {
  const raw = readJson<Record<string, unknown>>(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  return {
    theme:
      raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
        ? raw.theme
        : DEFAULT_SETTINGS.theme,
    colorMode: raw.colorMode === 'intl' ? 'intl' : 'cn',
    glass:
      raw.glass === 'classic' || raw.glass === 'vivid' || raw.glass === 'solid'
        ? raw.glass
        : 'clear',
    sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULT_SETTINGS.sound,
    notifications:
      typeof raw.notifications === 'boolean' ? raw.notifications : DEFAULT_SETTINGS.notifications,
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadTargets(): Record<InstrumentId, TargetRange> {
  const defaults = createDefaultTargets();
  const raw = readJson<Record<string, unknown>>(TARGETS_KEY);
  if (!raw) return defaults;
  for (const id of INSTRUMENT_IDS) {
    const value = raw[id];
    if (!isRecord(value)) continue;
    const low = positiveNumberOrNull(value.low);
    const high = positiveNumberOrNull(value.high);
    const bounds = low !== null || high !== null;
    defaults[id] = {
      low,
      high,
      enabled: bounds && value.enabled === true,
    };
  }
  return defaults;
}

export function saveTargets(targets: Record<InstrumentId, TargetRange>): void {
  writeJson(TARGETS_KEY, targets);
}

export function loadRuntime(): Record<InstrumentId, AlertRuntime> {
  const defaults = createDefaultRuntime();
  const raw = readJson<Record<string, unknown>>(RUNTIME_KEY);
  if (!raw) return defaults;
  for (const id of INSTRUMENT_IDS) {
    const value = raw[id];
    if (!isRecord(value)) continue;
    defaults[id] = {
      zone: value.zone === 'inside' ? 'inside' : 'outside',
      lastTriggeredAt:
        typeof value.lastTriggeredAt === 'number' && Number.isFinite(value.lastTriggeredAt)
          ? value.lastTriggeredAt
          : 0,
    };
  }
  return defaults;
}

export function saveRuntime(runtime: Record<InstrumentId, AlertRuntime>): void {
  writeJson(RUNTIME_KEY, runtime);
}

export function loadAlertLog(): AlertLogEntry[] {
  const raw = readJson<unknown[]>(LOG_KEY);
  if (!Array.isArray(raw)) return [];
  const entries: AlertLogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const instrument = item.instrument;
    if (typeof instrument !== 'string' || !INSTRUMENT_IDS.includes(instrument as InstrumentId)) {
      continue;
    }
    const price = positiveNumberOrNull(item.price);
    const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : null;
    if (price === null || at === null) continue;
    entries.push({
      id: typeof item.id === 'string' ? item.id : `${at}`,
      instrument: instrument as InstrumentId,
      price,
      low: positiveNumberOrNull(item.low),
      high: positiveNumberOrNull(item.high),
      at,
    });
    if (entries.length >= 20) break;
  }
  return entries;
}

export function saveAlertLog(entries: AlertLogEntry[]): void {
  writeJson(LOG_KEY, entries.slice(0, 20));
}

export function loadSelectedInstrument(): InstrumentId {
  try {
    const value = localStorage.getItem(SELECTED_KEY);
    if (value && INSTRUMENT_IDS.includes(value as InstrumentId)) return value as InstrumentId;
  } catch {
    // 忽略存储不可用
  }
  return 'xauusd';
}

export function saveSelectedInstrument(id: InstrumentId): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // 忽略存储不可用
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略存储不可用（隐私模式、配额限制）
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}
