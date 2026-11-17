import { useMemo } from 'react';
import { INSTRUMENT_MAP } from '../../shared/instruments';
import { groupAlertLog } from '../lib/alertLog';
import { formatLogTime, formatPrice, formatRangeLabel } from '../lib/format';
import type { AlertLogEntry } from '../lib/storage';

interface AlertLogProps {
  entries: readonly AlertLogEntry[];
}

function entryAction(low: number | null, high: number | null): string {
  if (low !== null && high !== null) return '进入目标区间';
  if (high !== null) return '下穿上限';
  if (low !== null) return '上穿下限';
  return '触发提醒';
}

export function AlertLog({ entries }: AlertLogProps) {
  const groups = useMemo(() => groupAlertLog(entries), [entries]);

  return (
    <section className="panel log-panel" aria-labelledby="log-title">
      <header className="panel-head">
        <div>
          <h2 id="log-title">提醒记录</h2>
          <p className="panel-sub">最近 20 条 · 仅保存在本机</p>
        </div>
      </header>

      {groups.length === 0 ? (
        <p className="empty-note">暂无提醒记录。价格触及已启用的目标区间后会显示在这里。</p>
      ) : (
        <ol className="log-list">
          {groups.map((group) => {
            const meta = INSTRUMENT_MAP[group.instrument];
            const action = entryAction(group.low, group.high);
            const timeLabel = formatLogTime(group.at);
            const countLabel =
              group.count > 1
                ? `共 ${group.count} 次 · ${formatLogTime(group.firstAt)} – ${timeLabel}`
                : undefined;

            return (
              <li key={group.id}>
                <div className="log-item">
                  <span className="log-dot" aria-hidden="true" />
                  <span className="log-copy">
                    <span className="log-headline">
                      <strong>{meta.name}</strong>
                      <span className="log-action">{action}</span>
                      {group.count > 1 && (
                        <span className="log-count" title={countLabel}>
                          {group.count} 次
                        </span>
                      )}
                    </span>
                    <span className="log-range">
                      目标 {formatRangeLabel(group.low, group.high, meta.decimals)} {meta.unitLabel}
                    </span>
                  </span>
                  <span className="log-side">
                    <span className="log-price">{formatPrice(group.price, meta.decimals)}</span>
                    <time dateTime={new Date(group.at).toISOString()} title={`最近一次提醒 ${timeLabel}`}>
                      {timeLabel}
                    </time>
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
