/**
 * 对照测试：用 web-push 标准库推一条到 FCM
 * 和 Worker 手写加密做对比
 */
import webpush from 'web-push';

// 从 Worker KV 拿所有订阅
const subsResp = await fetch('https://goldwatch.ichenghub.cn/api/push/subscriptions');
const subsData = await subsResp.json();

if (subsData.count === 0) {
  console.error('KV 里没有订阅！');
  process.exit(1);
}

// 找到 FCM 那条
const fcmSub = subsData.subscriptions.find(s => s.endpoint.includes('fcm.googleapis.com'));
if (!fcmSub) {
  console.error('没有找到 FCM 订阅！只有 Apple 的。');
  console.log('subs:', subsData.subscriptions.map(s => s.endpoint));
  process.exit(1);
}

// 拿完整数据（需要从 Worker 再拿一次完整 endpoint/p256dh/auth）
// 但 /api/push/subscriptions 返回的是截断的 endpoint
// 直接手动指定，或者让 first-subscription 返回 FCM 的
// 简单：用 first-subscription 拿第一条，然后比较 endpoint 前缀

// 让我直接用完整接口拿
// 先调 worker 的内部数据... 算了直接调手动 subscribe 接口传一个假的，让 worker 用同一个 key 存
// 更简单：直接让用户在 console 打印出来

console.log('FCM 订阅 endpoint 前缀:', fcmSub.endpoint);
console.log('p256dhLen:', fcmSub.p256dhLen, '(应该是 87 base64 = 65 字节)');
console.log('authLen:', fcmSub.authLen, '(应该是 22 base64 = 16 字节)');
console.log('\n⚠️  我需要完整的 endpoint / p256dh / auth 才能用 web-push 推');
console.log('请在 Chrome Console 里运行这段然后把输出贴给我：');
console.log('-----------------------------------------------------');
console.log('const d = await (await navigator.serviceWorker.ready).pushManager.getSubscription().then(s => s.toJSON());');
console.log('console.log("endpoint:", JSON.stringify(d.endpoint));');
console.log('console.log("p256dh:", JSON.stringify(d.keys.p256dh));');
console.log('console.log("auth:", JSON.stringify(d.keys.auth));');
console.log('-----------------------------------------------------');
