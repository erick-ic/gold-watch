/**
 * 关键对照：http_ece（Chrome 同款）能不能解开 Worker 加密的密文
 * 解不开 = Worker 加密有 bug
 * 能解开 = Worker 加密没问题，问题在别处
 */
import http_ece from 'http_ece';
import crypto from 'node:crypto';

// 完整 FCM 订阅数据（从 Worker /api/push/encrypt-test 拿）
const CLIENT_P256DH_B64URL = 'BLuqtgAzG-FG6NAwmRToRRVhaadYJYUqdI4Gm2svEIexip5wAsZgnUBF6KLHqB9p4yMZoK2rge2HUYFDAaZclW0';
const CLIENT_AUTH_B64URL = 'zw1BWJ3cUjs_VagaqTiVUw';

// Worker 加密的密文
const PLAINTEXT = '{"title":"Worker 加密测试","body":"这是 Worker 加密的内容","tag":"test"}';

function b64url2buf(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Buffer.from(b, 'base64');
}

function buf2hex(buf) {
  return buf.toString('hex');
}

const clientPub = b64url2buf(CLIENT_P256DH_B64URL);
const clientAuth = b64url2buf(CLIENT_AUTH_B64URL);

console.log('📡 客户端公钥 p256dh:', clientPub.length, '字节');
console.log('🔑 客户端 auth:', clientAuth.length, '字节');

// ======= 1. 让 Worker 加密 =======
console.log('\n🔐 让 Worker 加密 payload...');
const encResp = await fetch('https://goldwatch.ichenghub.cn/api/push/encrypt-test?target=fcm');
const encData = await encResp.json();
const workerCiphertext = Buffer.from(encData.encryptedBase64, 'base64');
console.log('  Worker 密文长度:', workerCiphertext.length, '字节');
console.log('  Worker 密文前 32 字节 hex:', buf2hex(workerCiphertext.slice(0, 32)));
console.log('  明文:', encData.plaintext);

// ======= 2. 用 http_ece 尝试解密 Worker 的密文 =======
console.log('\n🔓 用 http_ece (Chrome 同款) 解密 Worker 密文...');
try {
  const decrypted = http_ece.decrypt(workerCiphertext, {
    version: 'aes128gcm',
    privateKey: null, // 这里不需要，因为 decrypt 只做二进制层面
    keySalt: null,
    dh: null,
    authSecret: clientAuth,
  });
  console.log('  http_ece 解密结果:', decrypted ? decrypted.toString() : 'null');
} catch (e) {
  console.log('  http_ece 解密失败:', e.message);
}

// ======= 3. 用 Node.js crypto 完整重新加密，和 Worker 密文对比 =======
console.log('\n🔄 用 Node.js crypto 重新加密同样 payload...');

// 3a. 生成服务端 ECDH P-256 临时密钥对
const serverKey = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

// 导出 client 公钥
const clientPubKeyObj = crypto.createPublicKey({ key: clientPub, format: 'der', type: 'spki' });

// 3b. ECDH 共享值
const ecdhShared = crypto.diffieHellman({
  privateKey: crypto.createPrivateKey({ key: serverKey.privateKey, format: 'der', type: 'pkcs8' }),
  publicKey: clientPubKeyObj,
});
console.log('  ECDH shared:', ecdhShared.length, '字节');

// 3c. HKDF-Extract + Expand (rfc8291)
function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, length) {
  let result = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  let counter = 0;
  while (result.length < length) {
    counter++;
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([counter])])).digest();
    result = Buffer.concat([result, t]);
  }
  return result.slice(0, length);
}

const info = Buffer.concat([
  Buffer.from('WebPush: info\0'),
  clientPub,
  Buffer.from(serverKey.publicKey).subarray(2), // skip DER prefix for raw
]);

const prk = hkdfExtract(clientAuth, ecdhShared);
const webpushSecret = hkdfExpand(prk, info, 32);

const salt = crypto.randomBytes(16);
const prk2 = hkdfExtract(salt, webpushSecret);
const cek = hkdfExpand(prk2, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const baseNonce = hkdfExpand(prk2, Buffer.from('Content-Encoding: nonce\0'), 12);

// Node.js crypto 加密
const iv = baseNonce; // 简化：单 record 直接用 baseNonce
const cipher = crypto.createCipheriv('aes-128-gcm', cek, iv);
const nodejsCiphertext = Buffer.concat([cipher.update(Buffer.from(PLAINTEXT + '\x02')), cipher.final(), cipher.getAuthTag()]);

console.log('\n📊 Worker vs Node.js crypto 对比（同 clientPub + 同 auth + 同 salt 格式）:');
console.log('  注意：每次 ECDH 临时密钥和 salt 都是随机的，密文肯定不同');
console.log('  关键是解密时用相同流程能不能解开');

console.log('\n✅ Worker 加密密文 header hex (前 86 字节):');
console.log('  salt(16): ', buf2hex(workerCiphertext.slice(0, 16)));
console.log('  rs(4):    ', buf2hex(workerCiphertext.slice(16, 20)));
console.log('  keyid_len:', workerCiphertext[20]);
console.log('  keyid(65):', buf2hex(workerCiphertext.slice(21, 86)));
console.log('  records:  ', buf2hex(workerCiphertext.slice(86)));
