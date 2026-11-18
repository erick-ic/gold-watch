/**
 * Worker 加密密文精确解密验证
 * Worker 给了 cekHex + baseNonceHex，Node.js 用同样的值尝试 AES-128-GCM 解密
 * 
 * 能解开 → Worker 加密完全正确，问题在浏览器 SW push 事件没触发
 * 解不开 → Worker 加密流程有 bug
 */
import crypto from 'node:crypto';

// 从 Worker /api/push/encrypt-test?target=fcm 拿所有数据
console.log('📡 从 Worker 拿加密测试数据...');
const resp = await fetch('https://goldwatch.ichenghub.cn/api/push/encrypt-test?target=fcm');
const data = await resp.json();

const { plaintext, encryptedBase64, debug } = data;
const ciphertext = Buffer.from(encryptedBase64, 'base64');

console.log('\n📋 Worker debug 信息:');
console.log('  cekHex:', debug.cekHex);
console.log('  baseNonceHex:', debug.baseNonceHex);
console.log('  saltB64:', debug.saltB64);
console.log('  ephemeralPubB64:', debug.ephemeralPubB64);
console.log('  encryptedLen:', ciphertext.length, '字节');
console.log('  plaintext:', plaintext);

// ===== Worker 加密了 plaintext || padding-marker，然后 AES-GCM(iv=nonce, key=cek) =====
// 我们用同样的 cek + nonce 解密 + 去掉 padding marker

const cek = Buffer.from(debug.cekHex, 'hex');
const baseNonce = Buffer.from(debug.baseNonceHex, 'hex');

console.log('\n🔓 尝试 Node.js AES-128-GCM 解密...');

// aes128gcm 格式：binaryHeader + encrypted records
// binaryHeader = salt(16) + rs(4) + keyid_len(1) + keyid
// encrypted record = encrypted_data || auth_tag(16)

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;

// 解析 header
const salt = ciphertext.subarray(0, 16);
const rs = ciphertext.readUInt32BE(16);
const keyidLen = ciphertext[20];
const headerEnd = 21 + keyidLen;
const records = ciphertext.subarray(headerEnd);

console.log('  Header: salt=' + salt.toString('hex') + ' rs=' + rs + ' keyid_len=' + keyidLen);
console.log('  Records 区域长度:', records.length, '(应该包含至少1条 record)');

// 计算 baseNonce 每条记录的 XOR counter
function recordNonce(baseNonce, counter) {
  const nonce = Buffer.from(baseNonce);
  let c = counter;
  for (let i = NONCE_LENGTH - 1; i >= 6; i--) {
    nonce[i] ^= c & 0xff;
    c = Math.floor(c / 256);
  }
  return nonce;
}

// 拆 records：每条 record 长度 = min(rs, records剩余) + TAG_LENGTH
const decryptedParts = [];
let recordOffset = 0;
let counter = 0;

while (recordOffset < records.length) {
  const remaining = records.length - recordOffset;
  const dataLen = Math.min(rs, remaining - TAG_LENGTH); // 减去 tag
  if (dataLen <= 0) break;
  
  const encrypted = records.subarray(recordOffset, recordOffset + dataLen);
  const tag = records.subarray(recordOffset + dataLen, recordOffset + dataLen + TAG_LENGTH);
  
  const nonce = recordNonce(baseNonce, counter);
  console.log(`\n  Record #${counter}: nonce=${nonce.toString('hex')}`);
  console.log(`    encrypted(${dataLen} bytes) + tag(${TAG_LENGTH} bytes)`);
  
  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    
    // 去掉最后 1 字节 padding marker
    const padByte = decrypted[decrypted.length - 1];
    const realData = decrypted.subarray(0, decrypted.length - 1);
    
    console.log(`    ✅ 解密成功！padding marker=${padByte} (1=非末, 2=末)`);
    console.log(`    明文片段: "${realData.toString('utf8').slice(0, 50)}"`);
    
    decryptedParts.push(realData);
    
    if (padByte === 2) break; // 最后一条
  } catch (e) {
    console.log(`    ❌ GCM 解密失败: ${e.message}`);
    console.log('    这说明 Worker 的 cek + nonce 算错了！');
    break;
  }
  
  recordOffset += dataLen + TAG_LENGTH;
  counter++;
}

const fullDecrypted = Buffer.concat(decryptedParts).toString('utf8');
console.log('\n========== 最终结果 ==========');
console.log('Node.js 解密结果:', fullDecrypted);
console.log('Worker 原始明文:  ', plaintext);
console.log('匹配:', fullDecrypted === plaintext ? '✅ 完美匹配！' : '❌ 不匹配！Worker 加密有 bug');

if (fullDecrypted !== plaintext) {
  console.log('\n🔍 差异分析:');
  console.log('  Worker 明文长度:', plaintext.length);
  console.log('  解密明文长度:', fullDecrypted.length);
}
