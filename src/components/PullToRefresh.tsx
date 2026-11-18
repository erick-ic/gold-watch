import { useEffect, useRef, useState } from 'react';

const THRESHOLD = 56; // 触发刷新的下拉距离
const MAX_DISTANCE = 88; // 最大下拉距离
const RESISTANCE = 0.5; // 阻尼系数，让下拉手感更稳
const REFRESH_OFFSET = 46; // 刷新时内容让出的高度，便于展示指示器
const MIN_REFRESH_MS = 600; // 刷新过短时补足动画时长，避免闪一下
const DIRECTION_THRESHOLD = 8; // 位移足够明确后再锁定手势方向

type GestureAxis = 'none' | 'pending' | 'horizontal' | 'vertical';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  disabled?: boolean;
}

export function PullToRefresh({ onRefresh, disabled = false }: PullToRefreshProps) {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [supported, setSupported] = useState(false);

  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const axisRef = useRef<GestureAxis>('none');
  const pullingRef = useRef(false);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  const disabledRef = useRef(disabled);

  onRefreshRef.current = onRefresh;
  disabledRef.current = disabled;

  useEffect(() => {
    // 仅在触摸设备启用，桌面端保留浏览器原生行为
    setSupported(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  useEffect(() => {
    if (!supported) return;

    const onTouchStart = (event: TouchEvent): void => {
      if (refreshingRef.current || disabledRef.current) return;
      if (window.scrollY > 0 || event.touches.length !== 1) return;
      startXRef.current = event.touches[0].clientX;
      startYRef.current = event.touches[0].clientY;
      axisRef.current = 'pending';
      pullingRef.current = true;
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (!pullingRef.current || startXRef.current === null || startYRef.current === null) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - startXRef.current;
      const raw = touch.clientY - startYRef.current;

      if (axisRef.current === 'pending') {
        if (Math.max(Math.abs(deltaX), Math.abs(raw)) < DIRECTION_THRESHOLD) return;
        if (Math.abs(deltaX) > Math.abs(raw)) {
          axisRef.current = 'horizontal';
          return;
        }
        if (raw <= 0) {
          axisRef.current = 'none';
          return;
        }
        axisRef.current = 'vertical';
        document.documentElement.dataset.pulling = 'true';
      }

      if (axisRef.current !== 'vertical') return;
      if (raw <= 0) {
        distanceRef.current = 0;
        setDistance(0);
        return;
      }
      if (event.cancelable) event.preventDefault();
      const next = Math.min(raw * RESISTANCE, MAX_DISTANCE);
      distanceRef.current = next;
      setDistance(next);
    };

    const onTouchEnd = async (): Promise<void> => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      startXRef.current = null;
      startYRef.current = null;
      axisRef.current = 'none';
      document.documentElement.dataset.pulling = 'false';

      if (distanceRef.current < THRESHOLD) {
        distanceRef.current = 0;
        setDistance(0);
        return;
      }

      refreshingRef.current = true;
      setRefreshing(true);
      distanceRef.current = MAX_DISTANCE;
      setDistance(MAX_DISTANCE);
      const startedAt = Date.now();

      try {
        await onRefreshRef.current();
      } finally {
        const remain = MIN_REFRESH_MS - (Date.now() - startedAt);
        if (remain > 0) await new Promise((resolve) => window.setTimeout(resolve, remain));
        refreshingRef.current = false;
        setRefreshing(false);
        distanceRef.current = 0;
        setDistance(0);
      }
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [supported]);

  const pageOffset = refreshing ? REFRESH_OFFSET : distance;

  // 下拉过程中整体下移页面内容，给指示器留出空间
  useEffect(() => {
    document.documentElement.style.setProperty('--pull-offset', `${pageOffset}px`);
  }, [pageOffset]);

  useEffect(() => {
    const root = document.documentElement;
    return () => {
      root.style.removeProperty('--pull-offset');
      delete root.dataset.pulling;
    };
  }, []);

  if (!supported) return null;

  const reveal = refreshing ? 1 : Math.min(Math.max((distance - 16) / 20, 0), 1);
  const active = reveal > 0;
  const ready = distance >= THRESHOLD;
  const progress = Math.min(distance / THRESHOLD, 1);

  return (
    <div
      className="pull-refresh"
      data-state={refreshing ? 'refreshing' : ready ? 'ready' : 'pulling'}
      style={{ opacity: reveal }}
      aria-hidden={!active}
    >
      <span className="pull-refresh__icon">
        {refreshing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="8"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2.5"
            />
            <path
              d="M20 12a8 8 0 0 0-8-8"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            style={{ transform: `rotate(${progress * 180}deg)`, transformOrigin: 'center' }}
          >
            <path
              d="M12 5v14M6 13l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="sr-only">{refreshing ? '正在刷新行情' : '下拉刷新行情'}</span>
    </div>
  );
}
