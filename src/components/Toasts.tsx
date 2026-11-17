import { AlertIcon, BellIcon, CloseIcon, InfoIcon } from './Icons';

export interface ToastItem {
  id: string;
  kind: 'alert' | 'info';
  title: string;
  detail: string;
  time: string;
}

interface ToastsProps {
  items: readonly ToastItem[];
  onDismiss: (id: string) => void;
}

export function Toasts({ items, onDismiss }: ToastsProps) {
  return (
    <div className="toasts" aria-live="assertive" aria-atomic="false">
      {items.map((item) => (
        <div key={item.id} className="toast" data-kind={item.kind} role="alert">
          <span className="toast-icon" aria-hidden="true">
            {item.kind === 'alert' ? <BellIcon size={18} /> : <InfoIcon size={18} />}
          </span>
          <div className="toast-copy">
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
            <time>{item.time}</time>
          </div>
          <button
            type="button"
            className="icon-button icon-button--small"
            aria-label="关闭提示"
            onClick={() => onDismiss(item.id)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DataErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="panel error-panel" role="alert">
      <span className="error-icon" aria-hidden="true">
        <AlertIcon size={22} />
      </span>
      <h2>暂时无法获取行情</h2>
      <p>行情服务连接失败，请检查网络后重试。连接恢复后会自动继续刷新。</p>
      <button type="button" className="button button--primary" onClick={onRetry}>
        重新连接
      </button>
    </div>
  );
}
