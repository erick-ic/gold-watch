import { useEffect, useRef, useState } from 'react';

export function useAnimatedNumber(target: number | null, duration = 450): number | null {
  const [value, setValue] = useState(target);
  const displayRef = useRef<number | null>(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) {
      displayRef.current = null;
      setValue(null);
      return;
    }

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = displayRef.current;
    if (reduced || from === null || from === target) {
      displayRef.current = target;
      setValue(target);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = from + (target - from) * eased;
      displayRef.current = next;
      setValue(next);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        displayRef.current = target;
        setValue(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return value;
}
