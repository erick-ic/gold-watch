import {
  useId,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { InstrumentMeta } from '../../shared/instruments';
import type { HistoryPoint } from '../../shared/types';
import { samplePoints } from '../lib/history';
import { formatPrice, formatShortTime } from '../lib/format';
import { useElementSize } from '../hooks/useElementSize';
import type { TargetBounds } from '../lib/alerts';

interface ChartProps {
  points: readonly HistoryPoint[];
  meta: InstrumentMeta;
  prevClose: number | null;
  target: TargetBounds | null;
}

interface XY {
  x: number;
  y: number;
}

/** 超过该间隔视为休市断档，折线与面积不再跨段连接 */
const GAP_MS = 15 * 60 * 1000;

interface XTick {
  t: number;
  x: number;
  anchor: 'start' | 'middle' | 'end';
}

function monotonePath(points: XY[]): string {
  const count = points.length;
  if (count === 0) return '';
  if (count === 1) return `M ${points[0].x} ${points[0].y}`;
  if (count === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const width = points[i + 1].x - points[i].x;
    dx.push(width);
    slope.push(width === 0 ? 0 : (points[i + 1].y - points[i].y) / width);
  }

  const tangent = new Array<number>(count);
  tangent[0] = slope[0];
  tangent[count - 1] = slope[count - 2];
  for (let i = 1; i < count - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < count - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const width = dx[i];
    const c1x = current.x + width / 3;
    const c1y = current.y + (tangent[i] * width) / 3;
    const c2x = next.x - width / 3;
    const c2y = next.y - (tangent[i + 1] * width) / 3;
    path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return path;
}

function nearestIndex(points: readonly HistoryPoint[], time: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].t < time) low = mid + 1;
    else high = mid;
  }
  if (low > 0) {
    const previous = points[low - 1];
    const current = points[low];
    return Math.abs(previous.t - time) <= Math.abs(current.t - time) ? low - 1 : low;
  }
  return low;
}

export function Chart({ points, meta, prevClose, target }: ChartProps) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const rawId = useId();
  const gradientId = `area-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const sampled = useMemo(() => samplePoints(points, 420), [points]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = size.width;
  const height = size.height;

  const summary = useMemo(() => {
    if (sampled.length === 0) return '今日分时数据加载中。';
    const prices = sampled.map((point) => point.p);
    const latest = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    return `今日分时走势。最新 ${formatPrice(latest, meta.decimals)} ${meta.unitLabel}，最高 ${formatPrice(high, meta.decimals)}，最低 ${formatPrice(low, meta.decimals)}。`;
  }, [sampled, meta.decimals, meta.unitLabel]);

  const geometry = useMemo(() => {
    if (sampled.length < 2 || width < 120 || height < 100) return null;

    const values = sampled.map((point) => point.p);
    if (prevClose !== null && Number.isFinite(prevClose)) values.push(prevClose);
    if (target?.low !== null && target?.low !== undefined) values.push(target.low);
    if (target?.high !== null && target?.high !== undefined) values.push(target.high);

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.0006, 0.02);
    const yMin = rawMin - padding;
    const yMax = rawMax + padding;

    const gutter = width < 400 ? 56 : 66;
    const plotLeft = 6;
    const plotRight = Math.max(plotLeft + 60, width - gutter);
    const plotTop = 16;
    const plotBottom = Math.max(plotTop + 60, height - 26);
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    const tMin = sampled[0].t;
    const tMax = sampled[sampled.length - 1].t;
    const tSpan = tMax - tMin || 1;

    const xOf = (time: number): number => plotLeft + ((time - tMin) / tSpan) * plotWidth;
    const yOf = (price: number): number => plotTop + ((yMax - price) / (yMax - yMin)) * plotHeight;

    const coords = sampled.map((point) => ({ x: xOf(point.t), y: yOf(point.p) }));
    const segments: XY[][] = [];
    let segment: XY[] = [];
    for (let index = 0; index < coords.length; index += 1) {
      if (index > 0 && sampled[index].t - sampled[index - 1].t > GAP_MS) {
        if (segment.length > 0) segments.push(segment);
        segment = [];
      }
      segment.push(coords[index]);
    }
    if (segment.length > 0) segments.push(segment);

    const paths = segments.map((current) => {
      const line = monotonePath(current);
      const first = current[0];
      const last = current[current.length - 1];
      const area =
        current.length >= 2
          ? `${line} L ${last.x.toFixed(2)} ${plotBottom} L ${first.x.toFixed(2)} ${plotBottom} Z`
          : '';
      return { line, area };
    });

    const lastCoord = coords[coords.length - 1];

    const yTicks = [0, 1, 2, 3].map((index) => {
      const ratio = index / 3;
      return {
        y: plotTop + ratio * plotHeight,
        value: yMax - ratio * (yMax - yMin),
      };
    });

    const xTicks: XTick[] = [];
    const tickIndexes: Array<{ index: number; anchor: XTick['anchor'] }> = [
      { index: 0, anchor: 'start' },
      { index: Math.floor((sampled.length - 1) / 2), anchor: 'middle' },
      { index: sampled.length - 1, anchor: 'end' },
    ];
    for (const item of tickIndexes) {
      const point = sampled[item.index];
      if (!point) continue;
      if (xTicks.some((tick) => tick.t === point.t)) continue;
      xTicks.push({ t: point.t, x: xOf(point.t), anchor: item.anchor });
    }

    return {
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      plotWidth,
      tMin,
      tMax,
      xOf,
      yOf,
      lines: paths.map((path) => path.line),
      areas: paths.map((path) => path.area).filter(Boolean),
      lastCoord,
      yTicks,
      xTicks,
      yMin,
      yMax,
    };
  }, [sampled, width, height, prevClose, target?.low, target?.high]);

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < geometry.plotLeft - 10 || x > geometry.plotRight + 10) {
      setHoverIndex(null);
      return;
    }
    const ratio = Math.min(
      1,
      Math.max(0, (x - geometry.plotLeft) / (geometry.plotRight - geometry.plotLeft)),
    );
    const time = geometry.tMin + ratio * (geometry.tMax - geometry.tMin);
    setHoverIndex(nearestIndex(sampled, time));
  }

  const hoverPoint = hoverIndex !== null ? sampled[hoverIndex] : null;
  const hoverX = geometry && hoverPoint ? geometry.xOf(hoverPoint.t) : 0;
  const hoverY = geometry && hoverPoint ? geometry.yOf(hoverPoint.p) : 0;
  const clampedTooltipX = Math.min(Math.max(hoverX, 82), Math.max(82, width - 82));

  return (
    <div className="chart-canvas" ref={containerRef}>
      {geometry ? (
        <>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={summary}
            onPointerMove={handlePointer}
            onPointerDown={handlePointer}
            onPointerLeave={() => setHoverIndex(null)}
            onPointerCancel={() => setHoverIndex(null)}
            onPointerUp={(event) => {
              if (event.pointerType !== 'mouse') setHoverIndex(null);
            }}
          >
            <title>{summary}</title>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {geometry.yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line
                  className="chart-grid-line"
                  x1={geometry.plotLeft}
                  y1={tick.y}
                  x2={geometry.plotRight}
                  y2={tick.y}
                />
                <text
                  className="chart-axis-label"
                  x={geometry.plotRight + 9}
                  y={tick.y + 3.5}
                >
                  {formatPrice(tick.value, meta.decimals)}
                </text>
              </g>
            ))}

            {target && (target.low !== null || target.high !== null) && (
              <g>
                {target.low !== null && target.high !== null && (
                  <rect
                    x={geometry.plotLeft}
                    y={geometry.yOf(target.high)}
                    width={geometry.plotWidth}
                    height={Math.max(1, geometry.yOf(target.low) - geometry.yOf(target.high))}
                    fill="var(--accent)"
                    opacity="0.07"
                  />
                )}
                {target.high !== null && (
                  <line
                    x1={geometry.plotLeft}
                    y1={geometry.yOf(target.high)}
                    x2={geometry.plotRight}
                    y2={geometry.yOf(target.high)}
                    stroke="var(--accent)"
                    strokeWidth="1"
                    strokeDasharray="5 4"
                    opacity="0.5"
                  />
                )}
                {target.low !== null && (
                  <line
                    x1={geometry.plotLeft}
                    y1={geometry.yOf(target.low)}
                    x2={geometry.plotRight}
                    y2={geometry.yOf(target.low)}
                    stroke="var(--accent)"
                    strokeWidth="1"
                    strokeDasharray="5 4"
                    opacity="0.5"
                  />
                )}
                <text
                  className="chart-band-label"
                  x={geometry.plotRight - 6}
                  textAnchor="end"
                  y={Math.min(
                    geometry.plotBottom - 6,
                    Math.max(
                      geometry.plotTop + 10,
                      target.low !== null && target.high !== null
                        ? geometry.yOf(target.high) +
                            (geometry.yOf(target.low) - geometry.yOf(target.high) > 24 ? 13 : -6)
                        : target.high !== null
                          ? geometry.yOf(target.high) - 6
                          : target.low !== null
                            ? geometry.yOf(target.low) - 6
                            : geometry.plotTop + 12,
                    ),
                  )}
                >
                  目标区间
                </text>
              </g>
            )}

            {prevClose !== null && (
              <g>
                <line
                  x1={geometry.plotLeft}
                  y1={geometry.yOf(prevClose)}
                  x2={geometry.plotRight}
                  y2={geometry.yOf(prevClose)}
                  stroke="var(--text-tertiary)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                  opacity="0.55"
                />
                <text
                  className="chart-axis-label"
                  x={geometry.plotLeft + 4}
                  y={geometry.yOf(prevClose) - 5}
                >
                  昨收
                </text>
              </g>
            )}

            {geometry.areas.map((area, index) => (
              <path key={`area-${index}`} d={area} fill={`url(#${gradientId})`} />
            ))}
            {geometry.lines.map((line, index) => (
              <path
                key={`line-${index}`}
                d={line}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            <circle
              cx={geometry.lastCoord.x}
              cy={geometry.lastCoord.y}
              r="7"
              fill="var(--accent)"
              opacity="0.14"
            />
            <circle
              cx={geometry.lastCoord.x}
              cy={geometry.lastCoord.y}
              r="3"
              fill="var(--accent)"
              stroke="var(--panel-solid)"
              strokeWidth="1.5"
            />

            {hoverPoint && (
              <g>
                <line
                  x1={hoverX}
                  y1={geometry.plotTop}
                  x2={hoverX}
                  y2={geometry.plotBottom}
                  stroke="var(--text-tertiary)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.65"
                />
                <circle
                  cx={hoverX}
                  cy={hoverY}
                  r="4"
                  fill="var(--accent)"
                  stroke="var(--panel-solid)"
                  strokeWidth="2"
                />
              </g>
            )}

            {geometry.xTicks.map((tick) => (
              <text
                key={`x-${tick.t}`}
                className="chart-axis-label chart-axis-label--x"
                x={tick.x}
                y={height - 6}
                textAnchor={tick.anchor}
              >
                {formatShortTime(tick.t)}
              </text>
            ))}
          </svg>

          {hoverPoint && (
            <div
              className="chart-tooltip"
              style={{
                left: clampedTooltipX,
                top: hoverY,
                transform:
                  hoverY < 64 ? 'translate(-50%, 12px)' : 'translate(-50%, calc(-100% - 12px))',
              }}
            >
              <time>{formatShortTime(hoverPoint.t)}</time>
              <strong>{formatPrice(hoverPoint.p, meta.decimals)}</strong>
              <span>{meta.unitLabel}</span>
            </div>
          )}
        </>
      ) : (
        <div className="chart-empty">
          <span className="chart-empty__line" aria-hidden="true" />
          <p>{sampled.length === 0 ? '正在获取今日分时数据…' : '正在收集行情…'}</p>
        </div>
      )}
    </div>
  );
}
