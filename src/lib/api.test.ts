import { describe, expect, it } from 'vitest';
import { createApiError, getApiErrorInfo } from './api';

describe('createApiError', () => {
  it('识别 HTTP 429 限流', async () => {
    const error = await createApiError(new Response('', { status: 429 }));
    expect(error.info.title).toBe('请求过于频繁');
    expect(error.info.detail).toContain('429');
  });

  it('识别 Cloudflare 1015 限流', async () => {
    const error = await createApiError(new Response('Error 1015', { status: 429 }));
    expect(error.info.detail).toContain('1015');
  });

  it('识别 Cloudflare Worker 1101 执行异常', async () => {
    const error = await createApiError(new Response('<title>Error 1101</title>', { status: 500 }));
    expect(error.info.title).toBe('Cloudflare Worker 执行异常');
    expect(error.info.detail).toContain('1101');
  });

  it('识别 Cloudflare Worker 1102 资源超限', async () => {
    const error = await createApiError(new Response('Error code 1102', { status: 500 }));
    expect(error.info.title).toBe('Cloudflare Worker 资源超限');
    expect(error.info.detail).toContain('1102');
  });

  it('识别 Cloudflare 网关状态码', async () => {
    const error = await createApiError(new Response('', { status: 522 }));
    expect(error.info.title).toBe('Cloudflare 服务异常');
    expect(error.info.detail).toContain('522');
  });

  it('保留普通服务端错误状态码', async () => {
    const error = await createApiError(new Response('', { status: 503 }));
    expect(error.info.title).toBe('行情服务暂时不可用');
    expect(error.info.detail).toContain('503');
  });
});

describe('getApiErrorInfo', () => {
  it('网络请求失败时返回网络提示', () => {
    expect(getApiErrorInfo(new TypeError('Failed to fetch')).title).toBe('网络连接异常');
  });
});
