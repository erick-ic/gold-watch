import { useEffect, useState } from 'react';
import { formatMarketDate, formatTime } from '../lib/format';

interface LiveClockProps {
  className?: string;
}

export function LiveClock({ className }: LiveClockProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(tick, 1000 - (current % 1000) + 20);
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 20);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const date = formatMarketDate(now);
  const time = formatTime(now);

  return (
    <span
      className={`live-clock${className ? ` ${className}` : ''}`}
      role="timer"
      title="当前北京时间"
      aria-label={`当前北京时间 ${date} ${time}`}
    >
      <span className="live-clock__date" aria-hidden="true">
        {date}
      </span>
      <span className="live-clock__time" aria-hidden="true">
        {time}
      </span>
    </span>
  );
}
