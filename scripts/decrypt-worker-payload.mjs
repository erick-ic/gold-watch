/**
 * 核心对照测试：
 * 1. 从 Worker /api/push/encrypt-test 拿 FCM 订阅的加密密文
 * 2. 用 http_ece（Chrome 同款）在 Node.js 里尝试解密
 * 3. 能解开 → Worker 加密正确，问题在其他地方
 *    解不开 → Worker 加密实现有 bug
 */
import http_ece from 'http_ece';
import crypto from 'node:crypto';

// Step 1: 从 Worker 拿完整订阅数据
console.log('📡 从 Worker KV 拿 FCM 完整订阅...');
const subsResp = await fetch('https://goldwatch.ichenghub.cn/api/push/first-subscription');
const subs = await subsResp.json();

if (subs.error) {
  console.error('❌ KV 无订阅:', subs.error);
  process.exit(1);
}

// 但 first-subscription 返回的是 Apple 那条？让我用 subscriptions 先看哪条是 FCM
const listResp = await fetch('https://goldwatch.ichenghub.cn/api/push/subscriptions');
const list = await listResp.json();
console.log('  总订阅数:', list.count);
for (const s of list.subscriptions) {
  console.log(' -', s.endpoint.slice(0, 50), '...', 'FCM' if s.endpoint.includes('fcm') else 'Apple');
}

// Step 2: 让 Worker 加密一份 payload 并返回密文
const plaintext = JSON.stringify({ title: 'Worker 加密测试 ✅', body: '这是测试内容', tag: 'test-123' });
console.log('\n🔐 让 Worker 加密这份 payload...');
console.log('  plaintext:', plaintext);

const encResp = await fetch(
  `https://goldwatch.ichenghub.cn/api/push/encrypt-test?target=fcm&payload=${encodeURIComponent(plaintext)}`
);
const encData = await encResp.json();
console.log('  Worker 加密长度:', encData.encryptedLen, '字节');

// Step 3: 拿完整 FCM 订阅数据（用 endpoint 找）
const fullSubs = await fetch('https://goldwatch.ichenghub.cn/api/push/subscriptions').then(r => r.json());
console.log('  endpoint prefix:', encData.targetEndpointPrefix);

// 需要完整的 p256dh 和 auth 来解密
// 从 first-subscription 拿一条，如果是 Apple 那就用另一个接口...
// 让 Worker 再给我们一条完整的
const allResp = await fetch('https://goldwatch.ichenghub.cn/api/push/subscriptions');

// 简单：直接在 /api/push/encrypt-test 里让 Worker 返回它用的完整 p256dh 和 auth！
// 算了先手动构造 —— 直接用 KV 里 FCM 那条

// 让我换个思路：让 Worker /api/push/encrypt-test 返回完整 clientPub + clientAuth
// 我先看看 first-subscription 返回的是不是 FCM 那条
const firstSub = await fetch('https://goldwatch.ichenghub.cn/api/push/first-subscription').then(r => r.json());
console.log('\n  first-subscription endpoint:', firstSub.endpoint?.slice(0, 50));
console.log('  是 FCM?', firstSub.endpoint?.includes('fcm'));
console.log('  p256dh:', firstSub.p256dh, '(len:', firstSub.p256dh?.length, ')');
console.log('  auth:', firstSub.auth, '(len:', firstSub.auth?.length, ')');
