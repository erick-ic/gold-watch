function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function currentPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showSystemNotification(title: string, body: string, tag: string): boolean {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    const notification = new Notification(title, {
      body,
      icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
      tag,
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * 通过 Service Worker 展示通知（与 Web Push 使用同一条渲染/点击链路）。
 * 不支持 SW 或注册失败时退回到页面内 Notification。
 */
export async function showAlertNotification(
  title: string,
  body: string,
  tag: string,
): Promise<boolean> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, {
        body,
        icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
        badge: `${import.meta.env.BASE_URL}icons/icon-192.png`,
        tag,
        data: { url: './' },
      });
      return true;
    }
  } catch {
    // 退回页面内通知
  }
  return showSystemNotification(title, body, tag);
}
