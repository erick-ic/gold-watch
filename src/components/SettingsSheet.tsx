import { useEffect, useRef } from 'react';
import { formatBytes } from '../lib/format';
import type { ColorMode, GlassMode, Settings, ThemeMode } from '../lib/storage';
import { CloseIcon } from './Icons';
import { Switch } from './Switch';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (next: Settings) => void;
  permission: NotificationPermission | 'unsupported';
  onRequestNotifications: () => Promise<boolean>;
  onClearLog: () => void;
  hasLog: boolean;
  logCount: number;
  logBytes: number;
  onTestSound: () => void;
  webPushSupported: boolean;
  webPushActive: boolean;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const COLOR_OPTIONS: Array<{ value: ColorMode; label: string }> = [
  { value: 'cn', label: '红涨绿跌' },
  { value: 'intl', label: '绿涨红跌' },
];

const GLASS_OPTIONS: Array<{ value: GlassMode; label: string; desc: string }> = [
  { value: 'classic', label: '经典', desc: '较实的面板与柔和背景' },
  { value: 'clear', label: '通透', desc: '更透的玻璃与浓郁光斑' },
  { value: 'vivid', label: '浓郁', desc: '高对比背景，磨砂感最强' },
  { value: 'solid', label: '纯色', desc: '不透明面板，关闭磨砂' },
];

export function SettingsSheet({
  open,
  onClose,
  settings,
  onChange,
  permission,
  onRequestNotifications,
  onClearLog,
  hasLog,
  logCount,
  logBytes,
  onTestSound,
  webPushSupported,
  webPushActive,
}: SettingsSheetProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const permissionText =
    permission === 'granted'
      ? '系统通知已授权'
      : permission === 'denied'
        ? '已被浏览器拒绝，请在站点设置中允许通知'
        : permission === 'unsupported'
          ? '当前浏览器不支持系统通知'
          : '开启时将请求浏览器授权';

  async function toggleNotifications(next: boolean): Promise<void> {
    if (!next) {
      onChange({ ...settings, notifications: false });
      return;
    }
    const granted = await onRequestNotifications();
    onChange({ ...settings, notifications: granted });
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <div className="sheet-panel">
        <header className="sheet-head">
          <h2 id="settings-title">设置</h2>
          <button
            type="button"
            className="icon-button"
            onClick={() => dialogRef.current?.close()}
            aria-label="关闭设置"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="sheet-scroll">
          <section className="sheet-section" aria-labelledby="settings-appearance">
            <h3 id="settings-appearance">外观</h3>
            <div className="setting-row setting-row--stack">
              <div className="setting-copy">
                <span className="setting-label">主题</span>
                <span className="setting-desc">默认跟随系统外观</span>
              </div>
              <div className="segmented segmented--full" role="radiogroup" aria-label="主题">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === option.value}
                    className="segmented__item"
                    onClick={() => onChange({ ...settings, theme: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row setting-row--stack">
              <div className="setting-copy">
                <span className="setting-label">涨跌配色</span>
                <span className="setting-desc">中国习惯为红涨绿跌</span>
              </div>
              <div className="segmented segmented--full" role="radiogroup" aria-label="涨跌配色">
                {COLOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.colorMode === option.value}
                    className="segmented__item"
                    onClick={() => onChange({ ...settings, colorMode: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row setting-row--stack">
              <div className="setting-copy">
                <span className="setting-label">毛玻璃风格</span>
                <span className="setting-desc">
                  {GLASS_OPTIONS.find((option) => option.value === settings.glass)?.desc}
                </span>
              </div>
              <div className="segmented segmented--full" role="radiogroup" aria-label="毛玻璃风格">
                {GLASS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.glass === option.value}
                    className="segmented__item"
                    onClick={() => onChange({ ...settings, glass: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="sheet-section" aria-labelledby="settings-alerts">
            <h3 id="settings-alerts">提醒</h3>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">提示音</span>
                <span className="setting-desc">到价时播放简短铃声</span>
              </div>
              <div className="setting-control">
                <button type="button" className="text-button" onClick={onTestSound}>
                  试听
                </button>
                <Switch
                  checked={settings.sound}
                  label="提示音"
                  onChange={(checked) => {
                    onChange({ ...settings, sound: checked });
                    if (checked) onTestSound();
                  }}
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">页面内通知</span>
                <span className="setting-desc">到价时在页面右上角弹出提示</span>
              </div>
              <Switch
                checked={settings.pageNotifications}
                label="页面内通知"
                onChange={(checked) => onChange({ ...settings, pageNotifications: checked })}
              />
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">系统通知</span>
                <span className="setting-desc">{permissionText}</span>
              </div>
              <Switch
                checked={settings.notifications && permission === 'granted'}
                label="系统通知"
                disabled={permission === 'unsupported'}
                onChange={(checked) => {
                  void toggleNotifications(checked);
                }}
              />
            </div>
            {webPushSupported && (
              <div className="setting-row">
                <div className="setting-copy">
                  <span className="setting-label">后台推送</span>
                  <span className="setting-desc">
                    {webPushActive
                      ? '已开启，浏览器关闭后也能收到到价提醒'
                      : '随系统通知一同开启，浏览器关闭后仍可推送'}
                  </span>
                </div>
                <span className={`setting-value ${webPushActive ? 'setting-value--ok' : ''}`}>
                  {webPushActive ? '已连接' : '未连接'}
                </span>
              </div>
            )}
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">提醒频率</span>
                <span className="setting-desc">仅交易时段提醒，1 分钟内不重复</span>
              </div>
              <span className="setting-value">固定</span>
            </div>
          </section>

          <section className="sheet-section" aria-labelledby="settings-data">
            <h3 id="settings-data">数据</h3>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">刷新频率</span>
                <span className="setting-desc">服务端轮询并通过 SSE 实时推送</span>
              </div>
              <span className="setting-value">2 秒</span>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">行情来源</span>
                <span className="setting-desc">新浪财经 · 东方财富 · 上金所 · 京东金融</span>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">时间基准</span>
                <span className="setting-desc">所有行情时间均为北京时间（UTC+8）</span>
              </div>
            </div>
          </section>

          <section className="sheet-section" aria-labelledby="settings-log">
            <h3 id="settings-log">提醒记录</h3>
            <div className="setting-row">
              <div className="setting-copy">
                <span className="setting-label">本地记录</span>
                <span className="setting-desc">
                  仅保存在当前浏览器，不会上传
                  {logCount > 0 ? ` · ${logCount} 条 / ${formatBytes(logBytes)}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="text-button text-button--danger"
                onClick={onClearLog}
                disabled={!hasLog}
              >
                清除记录
              </button>
            </div>
          </section>

          <p className="sheet-footnote">
            行情数据仅供参考，可能存在延迟，不构成任何投资建议。GoldWatch v1.0.0
          </p>
        </div>
      </div>
    </dialog>
  );
}
