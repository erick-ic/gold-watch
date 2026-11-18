/**
 * 用 http_ece (Chrome 同款实现) 解密 Worker 加密的 payload
 * 同时用 http_ece 自己加密一份，和 Worker 加密的做对比
 * 
 * 运行方式：
 *   1. 先从 Worker /api/push/first-subscription 拿 FCM 订阅数据
 *   2. 调 Worker /api/push/test 让它加密一份 payload 返回密文
 *   3. 用 http_ece 尝试解密 → 能解开 = Worker 加密正确
 *   4. 用 http_ece 加密同样 payload → 和 Worker 密文对比
 */
import http_ece from 'http_ece';

// ===== Step 1: 从 Worker 拿 FCM 订阅 =====
console.log('📡 从 Worker KV 拿 FCM 订阅...');
const subsResp = await fetch('https://goldwatch.ichenghub.cn/api/push/subscriptions');
const subsData = await subsResp.json();

if (subsData.count === 0) {
  console.error('KV 空！');
  process.exit(1);
}

// 用 /api/push/test 让 Worker 加密并返回密文
// 先让用户在 Console 里把完整数据贴给 Worker... 
// 或者：让 /api/push/test 返回加密后的二进制（加个新接口）

// 简单：直接构造测试
// 我们需要：clientPub (p256dh), clientAuth (auth), payload

// 让我从 Worker 加个接口返回加密结果
// 这里先假设用户手动给我们完整数据

console.log('\n=== 需要你提供的数据 ===');
console.log('请在 Chrome Console 运行：');
console.log(`
(async () => {
  const d = await (await navigator.serviceWorker.ready).pushManager.getSubscription().then(s => s.toJSON());
  console.log(JSON.stringify({endpoint: d.endpoint, p256dh: d.keys.p256dh, auth: d.keys.auth}));
})();
`);
console.log('然后把输出的 JSON 贴给我。');
