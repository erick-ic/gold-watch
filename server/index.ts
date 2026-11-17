import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { isInstrumentId } from '../shared/instruments.js';
import type { HealthResponse, MarketSnapshot } from '../shared/types.js';
import {
  MAX_SSE_CLIENTS,
  POLL_INTERVAL_MS,
  PORT,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  STALE_AFTER_MS,
} from './config.js';
import { getHistory, marketService } from './data/service.js';

const app = express();
const startedAt = Date.now();
const distDir = path.resolve(process.cwd(), 'dist');
const indexFile = path.join(distDir, 'index.html');
const hasBuild = fs.existsSync(indexFile);
const sseClients = new Set<Response>();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});

const buckets = new Map<string, { count: number; resetAt: number }>();
const bucketSweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS);
bucketSweeper.unref();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: '请求过于频繁，请稍后重试' });
    return;
  }
  next();
}

app.get('/api/quotes', rateLimit, (_req, res) => {
  const snapshot = marketService.getSnapshot();
  if (!snapshot) {
    res.setHeader('Retry-After', '2');
    res.status(503).json({ error: '行情数据尚未就绪，请稍后重试' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(snapshot);
});

app.get('/api/history', rateLimit, async (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!isInstrumentId(id)) {
    res.status(400).json({ error: '未知的行情代码' });
    return;
  }
  const quote = marketService.getSnapshot()?.quotes.find((item) => item.id === id);
  const history = await getHistory(id, quote?.prevClose ?? null);
  res.setHeader('Cache-Control', 'no-store');
  res.json(history);
});

app.get('/api/health', rateLimit, (_req, res) => {
  const snapshot = marketService.getSnapshot();
  const health: HealthResponse = {
    ok: snapshot !== null && !marketService.isStale(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    lastSuccessAt: marketService.getLastSuccessAt(),
    lastError: marketService.getLastError(),
    clients: sseClients.size,
    sources: marketService.getSourceCounts(),
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json(health);
});

function writeEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

app.get('/api/stream', (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    res.status(503).json({ error: '实时连接数已达上限' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  res.flushHeaders?.();
  req.socket.setNoDelay(true);
  res.socket?.setKeepAlive(true, 30_000);

  sseClients.add(res);

  const snapshot = marketService.getSnapshot();
  if (snapshot) writeEvent(res, 'quotes', snapshot);

  const unsubscribe = marketService.onUpdate((next: MarketSnapshot) => {
    writeEvent(res, 'quotes', next);
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

if (hasBuild) {
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: false,
    }),
  );
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (error) => {
      if (error) next(error);
    });
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('前端尚未构建。开发模式请访问 http://localhost:5173，生产模式请先运行 npm run build。');
  });
}

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not Found');
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  if (res.headersSent) return;
  if (status === 404) {
    res.status(404).type('text/plain').send('Not Found');
    return;
  }
  console.error('[server]', error instanceof Error ? error.message : error);
  res.status(500).json({ error: '服务器内部错误' });
});

marketService.start();

const server = app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  console.log(`[api] quote poll interval ${POLL_INTERVAL_MS} ms, stale after ${STALE_AFTER_MS} ms`);
  if (!hasBuild) {
    console.log('[api] dist/ not found — use `npm run dev` for the Vite dev server');
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received, shutting down`);
  marketService.stop();
  for (const client of sseClients) client.end();
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
