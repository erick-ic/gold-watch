export interface ApiErrorInfo {
  title: string;
  detail: string;
}

export class ApiRequestError extends Error {
  readonly info: ApiErrorInfo;

  constructor(info: ApiErrorInfo) {
    super(info.detail);
    this.name = 'ApiRequestError';
    this.info = info;
  }
}

/** 将 HTTP 与 Cloudflare 错误转换为可直接展示的简短说明 */
export async function createApiError(response: Response): Promise<ApiRequestError> {
  const body = await response.text().catch(() => '');
  const cloudflareCode = body.match(/\berror\s*(?:code\s*)?(1015|1101|1102)\b/i)?.[1];
  const status = response.status;

  if (status === 429 || cloudflareCode === '1015') {
    return new ApiRequestError({
      title: '请求过于频繁',
      detail: cloudflareCode === '1015'
        ? 'Cloudflare 已暂时限制请求（1015），请稍后重试。'
        : '行情接口暂时限流（429），请稍后重试。',
    });
  }
  if (cloudflareCode === '1101') {
    return new ApiRequestError({
      title: 'Cloudflare Worker 执行异常',
      detail: '云端行情计算暂时失败（1101），请稍后重试。',
    });
  }
  if (cloudflareCode === '1102') {
    return new ApiRequestError({
      title: 'Cloudflare Worker 资源超限',
      detail: '云端行情服务暂时超出资源限制（1102），请稍后重试。',
    });
  }
  if (status >= 520 && status <= 530) {
    return new ApiRequestError({
      title: 'Cloudflare 服务异常',
      detail: `云端行情连接失败（${status}），请稍后重试。`,
    });
  }
  if (status >= 500) {
    return new ApiRequestError({
      title: '行情服务暂时不可用',
      detail: `服务响应异常（${status}），请稍后重试。`,
    });
  }
  return new ApiRequestError({
    title: '行情请求失败',
    detail: `接口返回异常状态（${status}），请稍后重试。`,
  });
}

export function getApiErrorInfo(error: unknown): ApiErrorInfo {
  if (error instanceof ApiRequestError) return error.info;
  return {
    title: '网络连接异常',
    detail: '无法连接行情服务，请检查网络后重试。',
  };
}

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** 行情 API 地址；本地开发为空字符串走 Vite 代理，部署到 GitHub Pages 时指向 serverless 服务 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** 远程 serverless 模式：无 SSE 长连接，改用轮询 */
export function hasRemoteApi(): boolean {
  return API_BASE !== '';
}
