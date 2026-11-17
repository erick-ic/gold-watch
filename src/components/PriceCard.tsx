import { useEffect, useRef, useState } from 'react';
import type { InstrumentMeta } from '../../shared/instruments';
import type { HistoryPoint, MarketSession, Quote } from '../../shared/types';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import {
  formatPercent,
  formatPrice,
  formatShortTime,
  formatSigned,
  splitPrice,
} from '../lib/format';
import { ChangeBadge } from './ChangeBadge';
import { Sparkline } from './Sparkline';

interface PriceCardProps {
  meta: InstrumentMeta;
  quote: Quote | undefined;
  session: MarketSession | undefined;
  points: readonly HistoryPoint[];
  active: boolean;
  onSelect: () => void;
}

function usePriceFlash(value: number | null): 'up' | 'down' | null {
  const previousRef = useRef<number | null>(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = value;
    if (previous === null || value === null || previous === value) return;
    setFlash(value > previous ? 'up' : 'down');
    const timer = window.setTimeout(() => setFlash(null), 900);
    return () => window.clearTimeout(timer);
  }, [value]);

  return flash;
}

export function PriceCard({
  meta,
  quote,
  session,
  points,
  active,
  onSelect,
}: PriceCardProps) {
  const animated = useAnimatedNumber(quote?.price ?? null);
  const flash = usePriceFlash(quote?.price ?? null);
  const { int, frac } = splitPrice(animated, meta.decimals);
  const changeLabel =
    quote?.change !== null && quote?.change !== undefined
      ? `，${formatSigned(quote.change, meta.decimals)}，${formatPercent(quote.changePct)}`
      : '';
  const closed = session && session.phase !== 'open';
  const timePrefix = session?.phase === 'break' ? '最新' : session?.phase === 'closed' ? '收盘' : '行情';
  const timeLabel = quote?.quoteTime
    ? `${timePrefix} ${formatShortTime(quote.quoteTime)}`
    : '等待行情';
  let sampledHigh: number | null = null;
  let sampledLow: number | null = null;
  for (const point of points) {
    if (sampledHigh === null || point.p > sampledHigh) sampledHigh = point.p;
    if (sampledLow === null || point.p < sampledLow) sampledLow = point.p;
  }
  const high = quote?.high ?? sampledHigh;
  const low = quote?.low ?? sampledLow;

  return (
    <button
      type="button"
      className="market-card"
      aria-pressed={active}
      onClick={onSelect}
      aria-label={`${meta.name} ${meta.symbol}，最新价 ${formatPrice(quote?.price, meta.decimals)} ${meta.unitLabel}${changeLabel}${closed ? `，${session?.label}` : ''}`}
    >
      <span className="market-card__head">
        <span className="market-card__names">
          <span className="market-card__name">{meta.name}</span>
          <span className="market-card__symbol">{meta.symbol}</span>
        </span>
        <span className="market-card__tags">
          {quote?.derived && <span className="tag tag--accent">参考换算</span>}
          {closed && (
            <span className="tag tag--muted" title={session?.detail}>
              {session?.label}
            </span>
          )}
          {quote?.stale && <span className="tag tag--warn">延迟</span>}
        </span>
      </span>

      <span className="market-card__price" data-flash={flash ?? undefined}>
        <span className="market-card__int">{int}</span>
        {frac && <span className="market-card__frac">.{frac}</span>}
        <span className="market-card__unit">{meta.unitLabel}</span>
      </span>

      <span className="market-card__row">
        <ChangeBadge change={quote?.change} changePct={quote?.changePct} decimals={meta.decimals} />
        <span className="market-card__time" title={session?.detail}>
          {timeLabel}
        </span>
      </span>

      <Sparkline points={points} trend={quote?.change ?? null} />

      <span className="market-card__foot">
        <span>
          {meta.hasOhlc === false ? '采样高' : '最高'} {formatPrice(high, meta.decimals)}
        </span>
        <span>
          {meta.hasOhlc === false ? '采样低' : '最低'} {formatPrice(low, meta.decimals)}
        </span>
      </span>
    </button>
  );
}
