import { formatPercent, formatSigned } from '../lib/format';
import { TrendArrow } from './Icons';

interface ChangeBadgeProps {
  change: number | null | undefined;
  changePct: number | null | undefined;
  decimals?: number;
  compact?: boolean;
}

export function ChangeBadge({ change, changePct, decimals = 2, compact = false }: ChangeBadgeProps) {
  if (change === null || change === undefined || changePct === null || changePct === undefined) {
    return <span className="change-badge change-badge--flat">—</span>;
  }
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const label =
    direction === 'flat'
      ? '持平'
      : `较昨收${direction === 'up' ? '上涨' : '下跌'} ${Math.abs(change).toFixed(decimals)}，${Math.abs(
          changePct,
        ).toFixed(2)}%`;

  return (
    <span className={`change-badge change-badge--${direction}`} aria-label={label}>
      {direction !== 'flat' && <TrendArrow direction={direction} />}
      {!compact && <span>{formatSigned(change, decimals)}</span>}
      <span className="change-badge__pct">{formatPercent(changePct)}</span>
    </span>
  );
}
