import type { MarketSnapshot } from '../../shared/types';
import type { ConnectionState } from '../hooks/useMarketData';
import { formatTime } from '../lib/format';
import { GearIcon, Logo, MoonIcon, SunIcon } from './Icons';
import { LiveClock } from './LiveClock';

interface HeaderProps {
  connection: ConnectionState;
  snapshot: MarketSnapshot | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export function Header({
  connection,
  snapshot,
  theme,
  onToggleTheme,
  onOpenSettings,
}: HeaderProps) {
  const degraded = snapshot?.degraded === true;
  let label = '连接中';
  let tone = 'idle';
  if (connection === 'live') {
    label = degraded ? '数据延迟' : '已连接';
    tone = degraded ? 'warn' : 'live';
  } else if (connection === 'retrying') {
    label = '重连中';
    tone = 'warn';
  }

  return (
    <header className="site-header">
      <div className="container header-inner">
        <div className="brand">
          <Logo />
          <span className="brand-name">GoldWatch</span>
        </div>

        <LiveClock className="header-clock" />

        <div className="header-meta">
          <span
            className="status-pill"
            data-tone={tone}
            role="status"
            aria-label={label}
            title="行情每 5 秒刷新；休市品种会标注交易状态"
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-pill__label">{label}</span>
          </span>
          {snapshot && (
            <span
              key={snapshot.fetchedAt}
              className="header-updated"
              aria-label={`行情数据更新于 ${formatTime(snapshot.fetchedAt)}`}
              title={`行情数据更新于 ${formatTime(snapshot.fetchedAt)}（北京时间）`}
            >
              <span className="header-updated__dot" aria-hidden="true" />
              <span className="header-updated__label">更新</span>
              <span>{formatTime(snapshot.fetchedAt)}</span>
            </span>
          )}
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="icon-button header-theme"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? '切换到浅色外观' : '切换到深色外观'}
            title={theme === 'dark' ? '浅色外观' : '深色外观'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            aria-label="打开设置"
            title="设置"
          >
            <GearIcon />
          </button>
        </div>
      </div>
    </header>
  );
}
