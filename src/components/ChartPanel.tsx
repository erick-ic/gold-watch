import { INSTRUMENTS, INSTRUMENT_MAP, type InstrumentId } from '../../shared/instruments';
import type { HistoryPoint, MarketSession, Quote } from '../../shared/types';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { normalizeRange, type TargetRange } from '../lib/alerts';
import {
  SOURCE_LABEL,
  formatPrice,
  formatTime,
  sourceLink,
  splitPrice,
} from '../lib/format';
import { ChangeBadge } from './ChangeBadge';
import { Chart } from './Chart';

function SourceTag({ quote, instrumentId }: { quote: Quote; instrumentId: InstrumentId }) {
  const label = quote.derived ? '参考换算' : SOURCE_LABEL[quote.source];
  const href = quote.derived ? undefined : sourceLink(quote.source, instrumentId);
  if (!href) return <span className="tag">{label}</span>;
  return (
    <a
      className="tag"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`打开${label}官方行情页核对数据`}
    >
      {label}
    </a>
  );
}

const SHORT_LABEL: Record<InstrumentId, string> = {
  xauusd: '伦敦金',
  au9999: '沪金 99',
  autd: '黄金 T+D',
  zsjcg: '浙商金',
};

interface ChartPanelProps {
  selectedId: InstrumentId;
  onSelect: (id: InstrumentId) => void;
  quotesById: Partial<Record<InstrumentId, Quote>>;
  sessions: Record<InstrumentId, MarketSession>;
  history: Record<InstrumentId, HistoryPoint[]>;
  targets: Record<InstrumentId, TargetRange>;
}

export function ChartPanel({
  selectedId,
  onSelect,
  quotesById,
  sessions,
  history,
  targets,
}: ChartPanelProps) {
  const meta = INSTRUMENT_MAP[selectedId];
  const quote = quotesById[selectedId];
  const session = sessions[selectedId];
  const target = targets[selectedId];
  const bounds = target.enabled ? normalizeRange(target) : null;
  const animated = useAnimatedNumber(quote?.price ?? null);
  const { int, frac } = splitPrice(animated, meta.decimals);
  const points = history[selectedId];

  let sampledOpen: number | null = null;
  let sampledHigh: number | null = null;
  let sampledLow: number | null = null;
  let sampledSum = 0;
  for (const point of points) {
    if (sampledOpen === null) sampledOpen = point.p;
    if (sampledHigh === null || point.p > sampledHigh) sampledHigh = point.p;
    if (sampledLow === null || point.p < sampledLow) sampledLow = point.p;
    sampledSum += point.p;
  }
  const sampledAvg = points.length > 0 ? sampledSum / points.length : null;

  const stats =
    meta.hasOhlc === false
      ? [
          { label: '采样开', value: sampledOpen },
          { label: '采样高', value: sampledHigh },
          { label: '采样低', value: sampledLow },
          { label: '最新', value: quote?.price ?? null },
          { label: '昨收', value: quote?.prevClose ?? null },
          { label: '采样均', value: sampledAvg },
        ]
      : [
          { label: '今开', value: quote?.open ?? null },
          { label: '最高', value: quote?.high ?? null },
          { label: '最低', value: quote?.low ?? null },
          { label: '昨收', value: quote?.prevClose ?? null },
          { label: '买价', value: quote?.bid ?? null },
          { label: '卖价', value: quote?.ask ?? null },
        ];

  return (
    <section className="panel chart-panel" aria-label={`${meta.name}行情走势`}>
      <div className="chart-top">
        <div className="segmented" role="group" aria-label="选择行情品种">
          {INSTRUMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="segmented__item"
              aria-pressed={selectedId === item.id}
              onClick={() => onSelect(item.id)}
            >
              {SHORT_LABEL[item.id]}
            </button>
          ))}
        </div>
        <span className="chart-caption">
          {meta.hasOhlc === false ? '采样分时 · 北京时间' : '今日分时 · 北京时间'}
        </span>
      </div>

      <div className="chart-hero">
        <div className="chart-hero__main">
          <p className="chart-hero__title">
            <span>{meta.name}</span>
            <span className="chart-hero__venue">{meta.venue}</span>
          </p>
          <div className="chart-price">
            <span className="chart-price__int">{int}</span>
            {frac && <span className="chart-price__frac">.{frac}</span>}
            <span className="chart-price__unit">{meta.unitLabel}</span>
          </div>
          <div className="chart-hero__sub">
            <ChangeBadge change={quote?.change} changePct={quote?.changePct} decimals={meta.decimals} />
            <span className="chart-quote-time">
              {session?.phase === 'open' ? '行情时间' : '最后更新'} {formatTime(quote?.quoteTime)}
            </span>
          </div>
        </div>
        <div className="chart-hero__tags">
          {quote && <SourceTag quote={quote} instrumentId={selectedId} />}
          {session && session.phase !== 'open' && (
            <span className="tag tag--muted" title={session.detail}>
              {session.label}
            </span>
          )}
          {quote?.stale && <span className="tag tag--warn">数据延迟</span>}
        </div>
      </div>

      {session && session.phase !== 'open' && (
        <p className="session-note" data-phase={session.phase}>
          <span className="session-note__dot" aria-hidden="true" />
          <span>
            <strong>{session.label}</strong> · {session.detail}，恢复交易后继续自动刷新。
          </span>
        </p>
      )}

      <Chart
        points={points}
        meta={meta}
        prevClose={quote?.prevClose ?? null}
        target={bounds}
      />

      <dl className="chart-stats">
        {stats.map((stat) => (
          <div key={stat.label} className="chart-stats__item">
            <dt>{stat.label}</dt>
            <dd>{formatPrice(stat.value, meta.decimals)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
