import { useEffect, useState } from 'react';
import type { InstrumentMeta } from '../../shared/instruments';
import type { MarketSession, Quote } from '../../shared/types';
import {
  normalizeRange,
  parseBounds,
  positionState,
  type TargetRange,
} from '../lib/alerts';
import { formatPercent, formatPrice, formatRangeLabel, formatSigned } from '../lib/format';
import { BellIcon, RefreshIcon } from './Icons';
import { Switch } from './Switch';

interface TargetPanelProps {
  meta: InstrumentMeta;
  quote: Quote | undefined;
  session: MarketSession | undefined;
  target: TargetRange;
  onChange: (next: TargetRange) => void;
  onStartMonitoring: (next: TargetRange) => void;
  onTest: () => void;
}

export function TargetPanel({
  meta,
  quote,
  session,
  target,
  onChange,
  onStartMonitoring,
  onTest,
}: TargetPanelProps) {
  const [lowDraft, setLowDraft] = useState(() => formatDraft(target.low, meta.decimals));
  const [highDraft, setHighDraft] = useState(() => formatDraft(target.high, meta.decimals));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLowDraft(formatDraft(target.low, meta.decimals));
    setHighDraft(formatDraft(target.high, meta.decimals));
    setError(null);
  }, [meta.id, meta.decimals, target.low, target.high]);

  const bounds = normalizeRange(target);
  const hasBounds = bounds !== null;
  const price = quote?.price ?? null;
  const state = bounds && price !== null ? positionState(bounds, price) : 'unset';

  function commit(): void {
    const parsed = parseBounds(lowDraft, highDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const hasAny = parsed.low !== null || parsed.high !== null;
    onChange({
      low: parsed.low,
      high: parsed.high,
      enabled: hasAny ? target.enabled : false,
    });
  }

  function resetDrafts(): void {
    setLowDraft(formatDraft(target.low, meta.decimals));
    setHighDraft(formatDraft(target.high, meta.decimals));
    setError(null);
  }

  function fillAroundPrice(): void {
    if (price === null) return;
    const factor = 0.01;
    const low = roundTo(price * (1 - factor), meta.decimals);
    const high = roundTo(price * (1 + factor), meta.decimals);
    setLowDraft(low.toFixed(meta.decimals));
    setHighDraft(high.toFixed(meta.decimals));
    setError(null);
    onChange({ low, high, enabled: true });
  }

  function clearTarget(): void {
    setLowDraft('');
    setHighDraft('');
    setError(null);
    onChange({ low: null, high: null, enabled: false });
  }

  function startMonitoring(): void {
    const parsed = parseBounds(lowDraft, highDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (parsed.low === null && parsed.high === null) {
      setError('请先填写目标区间');
      return;
    }
    setError(null);
    onStartMonitoring({ low: parsed.low, high: parsed.high, enabled: true });
  }

  const currencySymbol = meta.currency === 'USD' ? '$' : '¥';
  const pillLabel =
    state === 'inside' ? '区间内' : state === 'above' ? '高于上限' : state === 'below' ? '低于下限' : '未设置';

  let statusTitle = '尚未设置目标区间';
  let statusDetail = '填写下限或上限后即可开启提醒。';
  if (price === null) {
    statusTitle = '等待行情数据';
    statusDetail = '行情连接成功后自动开始监测。';
  } else if (state === 'inside' && bounds) {
    statusTitle = '价格位于目标区间';
    statusDetail = target.enabled
      ? '已在区间内；离开后再次进入会提醒，或点击「重新开始监控」立即重新判断。'
      : '开启提醒后，价格再次进入该区间时将提示。';
  } else if (state === 'above' && bounds && bounds.high !== null) {
    const diff = price - bounds.high;
    statusTitle = '价格高于目标上限';
    statusDetail = `现价 ${formatPrice(price, meta.decimals)}，距上限 ${formatSigned(diff, meta.decimals)}（${formatPercent((diff / bounds.high) * 100)}）`;
  } else if (state === 'below' && bounds && bounds.low !== null) {
    const diff = bounds.low - price;
    statusTitle = '价格低于目标下限';
    statusDetail = `现价 ${formatPrice(price, meta.decimals)}，距下限 ${formatSigned(diff, meta.decimals)}（${formatPercent((diff / bounds.low) * 100)}）`;
  }

  const switchHint = target.enabled
    ? bounds
      ? `正在监测 ${formatRangeLabel(bounds.low, bounds.high, meta.decimals)}`
      : '正在监测该区间'
    : hasBounds
      ? '区间已保存，开启后开始监测'
      : '请先填写目标区间';

  return (
    <section className="panel target-panel" aria-labelledby="target-title">
      <header className="panel-head">
        <div>
          <h2 id="target-title">到价提醒</h2>
          <p className="panel-sub">
            {meta.name} · {meta.symbol}
          </p>
        </div>
        <span className="target-pill" data-state={state}>
          {pillLabel}
        </span>
      </header>

      <p className="panel-hint">
        价格进入目标区间时提示，同一区间 1 分钟内不重复提醒；休市或行情延迟时不提醒。
      </p>

      {session && session.phase !== 'open' && (
        <p className="target-session" data-phase={session.phase}>
          <span className="target-session__dot" aria-hidden="true" />
          <span>
            <strong>{session.label}</strong> · {session.detail}。休市期间显示最后成交价且不触发提醒，恢复交易后继续监测。
          </span>
        </p>
      )}

      <div className="target-fields">
        <label className="target-field">
          <span className="target-label">目标下限</span>
          <span className="field">
            <span className="field-prefix" aria-hidden="true">
              {currencySymbol}
            </span>
            <input
              className="field-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="不限制"
              value={lowDraft}
              aria-label={`${meta.name}目标下限，单位${meta.unitLabel}`}
              onChange={(event) => {
                setLowDraft(event.target.value);
                setError(null);
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  resetDrafts();
                }
              }}
            />
            <span className="field-suffix">{meta.currency === 'USD' ? '美元' : '元'}</span>
          </span>
        </label>

        <label className="target-field">
          <span className="target-label">目标上限</span>
          <span className="field">
            <span className="field-prefix" aria-hidden="true">
              {currencySymbol}
            </span>
            <input
              className="field-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="不限制"
              value={highDraft}
              aria-label={`${meta.name}目标上限，单位${meta.unitLabel}`}
              onChange={(event) => {
                setHighDraft(event.target.value);
                setError(null);
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  resetDrafts();
                }
              }}
            />
            <span className="field-suffix">{meta.currency === 'USD' ? '美元' : '元'}</span>
          </span>
        </label>
      </div>

      {error ? (
        <p className="field-message field-message--error" role="alert">
          {error}
        </p>
      ) : (
        <p className="field-message">留空表示不限制该方向，按回车或移出输入框保存。</p>
      )}

      <div className="target-tools">
        <button type="button" className="text-button" onClick={fillAroundPrice} disabled={price === null}>
          以现价 ±1%
        </button>
        <button
          type="button"
          className="text-button text-button--muted"
          onClick={clearTarget}
          disabled={!hasBounds && !target.enabled}
        >
          清除
        </button>
      </div>

      <div className="switch-row">
        <div className="switch-copy">
          <strong>启用提醒</strong>
          <span>{switchHint}</span>
        </div>
        <Switch
          checked={target.enabled}
          disabled={!hasBounds}
          label={`启用${meta.name}到价提醒`}
          onChange={(checked) => onChange({ ...target, enabled: checked })}
        />
      </div>

      <div className="target-status" data-state={state}>
        <span className="target-status__dot" aria-hidden="true" />
        <div>
          <strong>{statusTitle}</strong>
          <span>{statusDetail}</span>
        </div>
      </div>

      <p className="target-channels">页内提示始终开启，提示音与系统通知可在设置中调整。</p>

      <div className="target-actions">
        <button
          type="button"
          className="button button--primary"
          onClick={startMonitoring}
          title="清除上一周期的提醒状态，按当前输入区间和现价重新开始监控"
        >
          <RefreshIcon size={16} />
          {target.enabled ? '重新开始监控' : '开始监控'}
        </button>
        <button type="button" className="button button--secondary" onClick={onTest}>
          <BellIcon size={16} />
          测试提醒
        </button>
      </div>
      <p className="target-start-note">
        开始监控会清除上一周期状态；交易时段内若现价已在区间，会立即提醒一次。
      </p>
    </section>
  );
}

function formatDraft(value: number | null, decimals: number): string {
  return value === null ? '' : value.toFixed(decimals);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
