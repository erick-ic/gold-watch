import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INSTRUMENT_IDS, type InstrumentId } from '../../shared/instruments';
import type { HistoryPoint, HistoryResponse, MarketSnapshot, Quote } from '../../shared/types';
import { mergePoints } from '../lib/history';

export type ConnectionState = 'connecting' | 'live' | 'retrying';

export interface MarketData {
  snapshot: MarketSnapshot | null;
  quotesById: Partial<Record<InstrumentId, Quote>>;
  history: Record<InstrumentId, HistoryPoint[]>;
  connection: ConnectionState;
  retry: () => void;
}

function emptyHistory(): Record<InstrumentId, HistoryPoint[]> {
  return INSTRUMENT_IDS.reduce(
    (acc, id) => {
      acc[id] = [];
      return acc;
    },
    {} as Record<InstrumentId, HistoryPoint[]>,
  );
}

export function useMarketData(): MarketData {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [history, setHistory] = useState<Record<InstrumentId, HistoryPoint[]>>(emptyHistory);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [retryKey, setRetryKey] = useState(0);
  const lastDataAtRef = useRef(0);

  useEffect(() => {
    const startedAt = Date.now();
    let disposed = false;
    let source: EventSource | null = null;
    let pollTimer: number | undefined;
    let watchdog: number | undefined;
    let hiddenAt = 0;

    function stopPolling(): void {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    function applySnapshot(incoming: MarketSnapshot, fromStream: boolean): void {
      if (disposed) return;
      setSnapshot(incoming);
      lastDataAtRef.current = Date.now();
      setConnection('live');
      setHistory((prev) => {
        const next = { ...prev };
        for (const quote of incoming.quotes) {
          const point = { t: quote.quoteTime ?? incoming.fetchedAt, p: quote.price };
          next[quote.id] = mergePoints(prev[quote.id], [point]);
        }
        return next;
      });
      if (fromStream) stopPolling();
    }

    async function loadQuotes(): Promise<void> {
      try {
        const response = await fetch('/api/quotes', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`行情接口返回 ${response.status}`);
        const data = (await response.json()) as MarketSnapshot;
        if (!Array.isArray(data?.quotes)) throw new Error('行情数据格式异常');
        applySnapshot(data, false);
      } catch {
        if (!disposed && Date.now() - lastDataAtRef.current > 15_000) {
          setConnection('retrying');
        }
      }
    }

    async function loadHistory(id: InstrumentId): Promise<void> {
      try {
        const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = (await response.json()) as HistoryResponse;
        if (disposed || !Array.isArray(data?.points)) return;
        setHistory((prev) => ({ ...prev, [id]: mergePoints(prev[id], data.points) }));
      } catch {
        // 分时历史缺失时保留会话内采样数据
      }
    }

    function startPolling(): void {
      if (pollTimer !== undefined) return;
      void loadQuotes();
      pollTimer = window.setInterval(() => {
        void loadQuotes();
      }, 10_000);
    }

    function connect(): void {
      try {
        source = new EventSource('/api/stream');
      } catch {
        setConnection('retrying');
        startPolling();
        return;
      }
      source.addEventListener('quotes', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as MarketSnapshot;
          if (!Array.isArray(data?.quotes)) return;
          applySnapshot(data, true);
        } catch {
          // 忽略格式异常的消息
        }
      });
      source.onerror = () => {
        if (disposed) return;
        startPolling();
        if (Date.now() - lastDataAtRef.current > 20_000) setConnection('retrying');
      };
    }

    function refreshAll(): void {
      void loadQuotes();
      for (const id of INSTRUMENT_IDS) void loadHistory(id);
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== 0 && Date.now() - hiddenAt > 30_000) refreshAll();
      hiddenAt = 0;
    }

    const onOnline = (): void => refreshAll();
    const onOffline = (): void => setConnection('retrying');

    void loadQuotes();
    for (const id of INSTRUMENT_IDS) void loadHistory(id);
    connect();

    watchdog = window.setInterval(() => {
      if (disposed) return;
      const last = lastDataAtRef.current;
      if (last > 0 && Date.now() - last > 20_000) {
        setConnection('retrying');
        startPolling();
      } else if (last === 0 && Date.now() - startedAt > 10_000) {
        setConnection('retrying');
        startPolling();
      }
    }, 5000);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      disposed = true;
      source?.close();
      stopPolling();
      if (watchdog !== undefined) window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [retryKey]);

  const retry = useCallback(() => {
    lastDataAtRef.current = 0;
    setConnection('connecting');
    setRetryKey((key) => key + 1);
  }, []);

  const quotesById = useMemo(() => {
    const map: Partial<Record<InstrumentId, Quote>> = {};
    for (const quote of snapshot?.quotes ?? []) map[quote.id] = quote;
    return map;
  }, [snapshot]);

  return { snapshot, quotesById, history, connection, retry };
}
