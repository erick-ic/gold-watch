const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** 行情 API 地址；本地开发为空字符串走 Vite 代理，部署到 GitHub Pages 时指向 serverless 服务 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** 远程 serverless 模式：无 SSE 长连接，改用轮询 */
export function hasRemoteApi(): boolean {
  return API_BASE !== '';
}
