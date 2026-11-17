import { useId, useMemo } from 'react';
import type { HistoryPoint } from '../../shared/types';
import { samplePoints } from '../lib/history';

interface SparklineProps {
  points: readonly HistoryPoint[];
  trend: number | null;
  height?: number;
}

const WIDTH = 200;

export function Sparkline({ points, trend, height = 44 }: SparklineProps) {
  const rawId = useId();
  const gradientId = `spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const sampled = useMemo(() => samplePoints(points, 100), [points]);

  if (sampled.length < 2) {
    return <div className="sparkline sparkline--empty" aria-hidden="true" />;
  }

  const min = Math.min(...sampled.map((point) => point.p));
  const max = Math.max(...sampled.map((point) => point.p));
  const span = max - min || 1;
  const top = 5;
  const bottom = height - 5;
  const usable = bottom - top;

  const coords = sampled.map((point, index) => {
    const x = (index / (sampled.length - 1)) * WIDTH;
    const y = max === min ? (top + bottom) / 2 : bottom - ((point.p - min) / span) * usable;
    return { x, y };
  });

  const line = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const area = `${line} L ${WIDTH} ${height} L 0 ${height} Z`;
  const color = trend === null || trend === 0 ? 'var(--accent)' : trend > 0 ? 'var(--up)' : 'var(--down)';
  const last = coords[coords.length - 1];

  return (
    <div className="sparkline" aria-hidden="true">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={last.x} cy={last.y} r="2" fill={color} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
