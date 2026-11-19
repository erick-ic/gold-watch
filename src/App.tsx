import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INSTRUMENTS,
  INSTRUMENT_MAP,
  type InstrumentId,
} from '../shared/instruments';
import { alertTag } from '../shared/alertTag';
import type { Quote } from '../shared/types';
import { AlertLog } from './components/AlertLog';
import { ChartPanel } from './components/ChartPanel';
import { Header } from './components/Header';
import { LiveClock } from './components/LiveClock';
import { PriceCard } from './components/PriceCard';
import { PullToRefresh } from './components/PullToRefresh';
import { SettingsSheet } from './components/SettingsSheet';
import { TargetPanel } from './components/TargetPanel';
import { DataErrorPanel, Toasts, type ToastItem } from './components/Toasts';
import { useMarketData } from './hooks/useMarketData';
import {
  ALERT_COOLDOWN_MS,
  isInRange,
  normalizeRange,
  shouldTrigger,
  type TargetBounds,
  type TargetRange,
} from './lib/alerts';
import { formatBytes, formatPrice, formatRangeLabel, formatTime, uid } from './lib/format';
import { currentPermission, requestPermission, showAlertNotification } from './lib/notify';
import {
  createPushSubscription,
  getExistingSubscription,
  pushSupported,
  subscribePush,
  unsubscribePush,
  updatePushTargets,
} from './lib/push';
import { playChime, primeAudio } from './lib/sound';
import {
  getAlertLogStorageBytes,
  loadAlertLog,
  loadRuntime,
  loadSelectedInstrument,
  loadSettings,
  loadTargets,
  saveAlertLog,
  saveRuntime,
  saveSelectedInstrument,
  saveSettings,
  saveTargets,
  type AlertLogEntry,
  type AlertRuntime,
  type Settings,
} from './lib/storage';

const BASE_TITLE = 'GoldWatch · 黄金实时行情与到价提醒';

export default function App() {
  const market = useMarketData();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [targets, setTargets] = useState<Record<InstrumentId, TargetRange>>(loadTargets);
  const [alertLog, setAlertLog] = useState<AlertLogEntry[]>(loadAlertLog);
  const logBytes = useMemo(() => getAlertLogStorageBytes(), [alertLog]);
  const [selectedId, setSelectedId] = useState<InstrumentId>(loadSelectedInstrument);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    currentPermission,
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [titleAlert, setTitleAlert] = useState(false);
  const [webPushActive, setWebPushActive] = useState(false);

  const runtimeRef = useRef<Record<InstrumentId, AlertRuntime>>(loadRuntime());
  const lastEvaluatedRef = useRef(0);
  const toastTimers = useRef(new Map<string, number>());
  const pushSubscriptionRef = useRef<PushSubscription | null>(null);

  const effectiveTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id' | 'time'>) => {
    const item: ToastItem = { ...toast, id: uid(), time: formatTime(Date.now()) };
    setToasts((prev) => [...prev.slice(-2), item]);
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((entry) => entry.id !== item.id));
      toastTimers.current.delete(item.id);
    }, 9000);
    toastTimers.current.set(item.id, timer);
  }, []);

  const pushAlert = useCallback(
    (quote: Quote, bounds: TargetBounds) => {
      const meta = INSTRUMENT_MAP[quote.id];
      const entry: AlertLogEntry = {
        id: uid(),
        instrument: quote.id,
        price: quote.price,
        low: bounds.low,
        high: bounds.high,
        at: Date.now(),
      };
      setAlertLog((prev) => {
        const next = [entry, ...prev].slice(0, 20);
        saveAlertLog(next);
        return next;
      });

      const range = formatRangeLabel(bounds.low, bounds.high, meta.decimals);
      if (settings.pageNotifications) {
        pushToast({
          kind: 'alert',
          title: `${meta.name}进入目标区间`,
          detail: `现价 ${formatPrice(quote.price, meta.decimals)} ${meta.unitLabel} · 目标 ${range}`,
        });
      }

      if (settings.sound) {
        primeAudio();
        playChime();
      }
      if (document.visibilityState === 'hidden') {
        setTitleAlert(true);
        if (settings.notifications && permission === 'granted') {
          // 与 Web Push 走同一条展示链路，且共用 tag，避免两条通道各弹一次
          void showAlertNotification(
            '金价到达目标区间',
            `${meta.name} ${formatPrice(quote.price, meta.decimals)} ${meta.unitLabel}，目标 ${range}。`,
            alertTag(quote.id),
          );
        }
      }
    },
    [permission, pushToast, settings.notifications, settings.pageNotifications, settings.sound],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.colors = settings.colorMode;
    document.documentElement.dataset.glass = settings.glass;
    for (const element of document.querySelectorAll('meta[name="theme-color"]')) {
      element.setAttribute('content', effectiveTheme === 'dark' ? '#0a0a0c' : '#f5f5f7');
      element.removeAttribute('media');
    }
    saveSettings(settings);
  }, [settings, effectiveTheme]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setSystemDark(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  useEffect(() => {
    const handler = () => primeAudio();
    window.addEventListener('pointerdown', handler, { passive: true, once: true });
    return () => window.removeEventListener('pointerdown', handler);
  }, []);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    document.title = titleAlert ? '到价提醒 · GoldWatch' : BASE_TITLE;
    if (!titleAlert) return;
    const onFocus = () => setTitleAlert(false);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setTitleAlert(false);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [titleAlert]);

  // === Web Push：组件挂载时检查现有订阅 ===
  useEffect(() => {
    if (!pushSupported()) return;
    getExistingSubscription()
      .then((sub) => {
        if (sub) {
          pushSubscriptionRef.current = sub;
          setWebPushActive(true);
        }
      })
      .catch(() => {
        // 忽略：浏览器可能静默拒绝
      });
  }, []);

  // === Web Push：targets 变化时同步到 Worker ===
  useEffect(() => {
    const sub = pushSubscriptionRef.current;
    if (!sub) return;
    updatePushTargets(sub, targets).catch(() => {
      // 静默：Worker 暂不可达不影响前端
    });
  }, [targets]);

  // === Web Push：settings.notifications 变化时自动订阅/注销 ===
  useEffect(() => {
    if (!pushSupported()) return;
    if (settings.notifications && permission === 'granted') {
      // 开启：先检查是否已有订阅
      getExistingSubscription()
        .then(async (existing) => {
          let sub = existing;
          if (!sub) {
            try {
              sub = await createPushSubscription();
            } catch {
              // 用户可能取消了授权请求
              return;
            }
          }
          if (sub) {
            pushSubscriptionRef.current = sub;
            await subscribePush(sub, targets);
            setWebPushActive(true);
          }
        })
        .catch(() => {
          // 忽略
        });
    } else if (!settings.notifications) {
      // 关闭：注销
      const sub = pushSubscriptionRef.current;
      if (sub) {
        unsubscribePush(sub).catch(() => { /* 静默 */ });
        pushSubscriptionRef.current = null;
        setWebPushActive(false);
      } else {
        // 可能浏览器侧有残留订阅但 ref 丢了，也尝试清理
        getExistingSubscription()
          .then((existing) => {
            if (existing) unsubscribePush(existing).catch(() => { /* 静默 */ });
          })
          .catch(() => { /* 忽略 */ });
      }
    }
  }, [settings.notifications, permission]);

  useEffect(() => {
    const snapshot = market.snapshot;
    if (!snapshot) return;
    if (lastEvaluatedRef.current === snapshot.fetchedAt) return;
    lastEvaluatedRef.current = snapshot.fetchedAt;
    const now = Date.now();
    let dirty = false;

    for (const quote of snapshot.quotes) {
      const target = targets[quote.id];
      if (!target?.enabled) continue;
      const bounds = normalizeRange(target);
      if (!bounds) continue;

      // 休市或行情延迟时不评估，保留上一状态，开盘/恢复后再判断是否穿越
      const session = snapshot.sessions[quote.id];
      if (session.phase !== 'open' || quote.stale) continue;

      const runtime = runtimeRef.current[quote.id] ?? { zone: 'outside', lastTriggeredAt: 0 };
      const inside = isInRange(bounds, quote.price);
      const trigger = shouldTrigger({
        bounds,
        price: quote.price,
        wasInside: runtime.zone === 'inside',
        lastTriggeredAt: runtime.lastTriggeredAt,
        now,
        cooldownMs: ALERT_COOLDOWN_MS,
      });
      if (trigger) {
        runtime.lastTriggeredAt = now;
        dirty = true;
        pushAlert(quote, bounds);
      }
      const zone = inside ? 'inside' : 'outside';
      if (runtime.zone !== zone) {
        runtime.zone = zone;
        dirty = true;
      }
      runtimeRef.current[quote.id] = runtime;
    }

    if (dirty) saveRuntime(runtimeRef.current);
  }, [market.snapshot, targets, pushAlert]);

  const updateTarget = useCallback(
    (id: InstrumentId, next: TargetRange) => {
      setTargets((prev) => {
        const updated = { ...prev, [id]: next };
        saveTargets(updated);
        return updated;
      });
      const bounds = normalizeRange(next);
      const quote = market.quotesById[id];
      const inside = bounds && quote ? isInRange(bounds, quote.price) : false;
      runtimeRef.current[id] = {
        zone: inside ? 'inside' : 'outside',
        lastTriggeredAt: 0,
      };
      saveRuntime(runtimeRef.current);
    },
    [market.quotesById],
  );

  const selectInstrument = useCallback((id: InstrumentId) => {
    setSelectedId(id);
    saveSelectedInstrument(id);
  }, []);

  const startMonitoring = useCallback(
    (next: TargetRange) => {
      setTargets((prev) => {
        const updated = { ...prev, [selectedId]: next };
        saveTargets(updated);
        return updated;
      });
      runtimeRef.current[selectedId] = { zone: 'outside', lastTriggeredAt: 0 };
      saveRuntime(runtimeRef.current);
      lastEvaluatedRef.current = 0;
    },
    [selectedId],
  );

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({ ...prev, theme: effectiveTheme === 'dark' ? 'light' : 'dark' }));
  }, [effectiveTheme]);

  const testSound = useCallback(() => {
    primeAudio();
    playChime();
  }, []);

  const handleTestAlert = useCallback(async () => {
    primeAudio();
    const quote = market.quotesById[selectedId];
    const meta = INSTRUMENT_MAP[selectedId];
    const bounds = normalizeRange(targets[selectedId]);
    if (!quote) {
      pushToast({
        kind: 'info',
        title: '行情尚未就绪',
        detail: '请稍候再试，或检查网络连接。',
      });
      return;
    }

    if (settings.sound) playChime();

    const priceText = formatPrice(quote.price, meta.decimals);
    const range = bounds ? formatRangeLabel(bounds.low, bounds.high, meta.decimals) : null;
    if (settings.pageNotifications) {
      pushToast({
        kind: 'alert',
        title: `${meta.name}提醒测试`,
        detail: range
          ? `当前 ${priceText} ${meta.unitLabel} · 目标 ${range}`
          : `当前 ${priceText} ${meta.unitLabel}，设置目标区间后将自动提醒。`,
      });
    }

    // 与真实到价提醒走同一套系统通知逻辑（含权限申请），只是不受页面可见性限制
    if (!settings.notifications) {
      pushToast({
        kind: 'info',
        title: '系统通知未开启',
        detail: '在设置中开启「系统通知」后，测试会同时弹出系统通知。',
      });
      return;
    }

    let granted = permission;
    if (granted !== 'granted' && granted !== 'denied' && granted !== 'unsupported') {
      granted = await requestPermission();
      setPermission(granted);
    }
    if (granted !== 'granted') {
      pushToast({
        kind: 'info',
        title: '系统通知不可用',
        detail:
          granted === 'denied'
            ? '浏览器已拒绝通知权限，请在站点设置中允许后重试。'
            : '当前浏览器或环境不支持系统通知。',
      });
      return;
    }

    const shown = await showAlertNotification(
      '金价到达目标区间（测试）',
      `${meta.name} ${priceText} ${meta.unitLabel}${range ? `，目标 ${range}` : ''}。`,
      `goldwatch-test-${selectedId}-${Date.now()}`,
    );
    if (!shown) {
      pushToast({
        kind: 'info',
        title: '系统通知发送失败',
        detail: '请检查浏览器与系统通知权限，或稍后重试。',
      });
    }
  }, [
    market.quotesById,
    permission,
    pushToast,
    selectedId,
    settings.notifications,
    settings.pageNotifications,
    settings.sound,
    targets,
  ]);

  const handleRequestNotifications = useCallback(async (): Promise<boolean> => {
    const result = await requestPermission();
    setPermission(result);
    if (result === 'granted') {
      pushToast({
        kind: 'info',
        title: '系统通知已开启',
        detail: '页面切到后台时也会收到到价提醒。',
      });
      return true;
    }
    pushToast({
      kind: 'info',
      title: '未能开启系统通知',
      detail:
        result === 'unsupported'
          ? '当前浏览器不支持系统通知。'
          : '请在浏览器站点设置中允许通知后重试。',
    });
    return false;
  }, [pushToast]);

  const handleClearLog = useCallback(() => {
    const count = alertLog.length;
    const bytes = getAlertLogStorageBytes();
    setAlertLog([]);
    saveAlertLog([]);
    pushToast({
      kind: 'info',
      title: '提醒记录已清空',
      detail: `已删除 ${count} 条本地记录，释放 ${formatBytes(bytes)} 存储空间。`,
    });
  }, [alertLog.length, pushToast]);

  const snapshot = market.snapshot;
  const selectedMeta = INSTRUMENT_MAP[selectedId];
  const selectedQuote = market.quotesById[selectedId];
  const showBanner = snapshot !== null && market.connection === 'retrying';

  return (
    <div className="app">
      <Header
        connection={market.connection}
        snapshot={snapshot}
        theme={effectiveTheme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <PullToRefresh onRefresh={market.refresh} disabled={settingsOpen} />

      <main className="page">
        <div className="container">
          <section className="intro">
            <div>
              <h1>黄金市场</h1>
              <p>追踪伦敦金、上金所与银行积存金报价，自定义目标区间，到价即刻提醒。</p>
            </div>
            <div className="intro-meta" aria-label="行情概览">
              <LiveClock className="intro-clock" />
              {snapshot && (
                <span
                  key={snapshot.fetchedAt}
                  className="update-chip"
                  aria-label={`行情数据更新于 ${formatTime(snapshot.fetchedAt)}`}
                  title={`行情数据更新于 ${formatTime(snapshot.fetchedAt)}（北京时间）`}
                >
                  <span className="update-chip__dot" aria-hidden="true" />
                  更新 {formatTime(snapshot.fetchedAt)}
                </span>
              )}
              {snapshot?.usdcny != null && (
                <span className="intro-fx">USD/CNY {snapshot.usdcny.toFixed(4)}</span>
              )}
            </div>
          </section>

          {showBanner && snapshot && (
            <div className="connection-banner" role="status">
              <span className="connection-banner__dot" aria-hidden="true" />
              {market.error?.detail ?? '行情连接中断。'} 正在自动重连，当前显示{' '}
              {formatTime(snapshot.fetchedAt)} 的数据。
            </div>
          )}

          {!snapshot ? (
            market.connection === 'retrying' ? (
              <DataErrorPanel error={market.error} onRetry={market.retry} />
            ) : (
              <LoadingState />
            )
          ) : (
            <>
              <div className="market-grid">
                {INSTRUMENTS.map((instrument) => (
                  <PriceCard
                    key={instrument.id}
                    meta={instrument}
                    quote={market.quotesById[instrument.id]}
                    session={snapshot.sessions[instrument.id]}
                    points={market.history[instrument.id]}
                    active={selectedId === instrument.id}
                    onSelect={() => selectInstrument(instrument.id)}
                  />
                ))}
              </div>

              <div className="main-grid">
                <ChartPanel
                  selectedId={selectedId}
                  onSelect={selectInstrument}
                  quotesById={market.quotesById}
                  sessions={snapshot.sessions}
                  history={market.history}
                  targets={targets}
                />
                <TargetPanel
                  meta={selectedMeta}
                  quote={selectedQuote}
                  session={snapshot.sessions[selectedId]}
                  target={targets[selectedId]}
                  onChange={(next) => updateTarget(selectedId, next)}
                  onStartMonitoring={startMonitoring}
                  onTest={handleTestAlert}
                />
              </div>

              <AlertLog entries={alertLog} />
            </>
          )}
        </div>
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <div className="footer-schedule">
            <dl className="footer-schedule__list">
              <div>
                <dt>上金所</dt>
                <dd>09:00–11:30 · 13:30–15:30 · 20:00–次日 02:30（周五无夜盘）</dd>
              </div>
              <div>
                <dt>浙商积存金</dt>
                <dd>工作日 24 小时 · 每日 23:50–00:10 清算</dd>
              </div>
              <div>
                <dt>伦敦金</dt>
                <dd>周一至周六凌晨 · 每日约 1 小时结算</dd>
              </div>
            </dl>
          </div>
          <p>行情数据仅供参考，可能延迟，不构成任何投资建议。所有时间均为北京时间。</p>
          <p>数据来源：新浪财经 · 东方财富 · 京东金融 · gold-api.com · GoldWatch</p>
        </div>
      </footer>

      <Toasts items={toasts} onDismiss={dismissToast} />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        permission={permission}
        onRequestNotifications={handleRequestNotifications}
        onClearLog={handleClearLog}
        hasLog={alertLog.length > 0}
        logCount={alertLog.length}
        logBytes={logBytes}
        onTestSound={testSound}
        webPushSupported={pushSupported()}
        webPushActive={webPushActive}
      />
    </div>
  );
}

function LoadingState() {
  return (
    <>
      <div className="market-grid" aria-hidden="true">
        {INSTRUMENTS.map((instrument) => (
          <div key={instrument.id} className="panel skeleton-card">
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--price" />
            <div className="skeleton skeleton--spark" />
          </div>
        ))}
      </div>
      <div className="main-grid">
        <div className="panel skeleton-chart" aria-hidden="true">
          <div className="skeleton skeleton--chart" />
        </div>
        <div className="panel skeleton-side" aria-hidden="true">
          <div className="skeleton skeleton--line" />
          <div className="skeleton skeleton--line" />
          <div className="skeleton skeleton--line skeleton--short" />
        </div>
      </div>
      <p className="loading-note" role="status">
        正在连接实时行情…
      </p>
    </>
  );
}
