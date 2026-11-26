import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeNewFile } from './write-new-file.mjs';

function mapKey() {
  // Default map format seed from lothar-map-crypto.mjs; sites may override it.
  const seed = process.env.TUSK_MAP_KEY || 'tusk_gogogo';
  // The 5.10 Java codec seeds Sun SHA1PRNG before its first read. AES
  // KeyGenerator uses the first 16 bytes of SHA1(SHA1(seed)).
  const state = createHash('sha1').update(seed, 'utf8').digest();
  return createHash('sha1').update(state).digest().subarray(0, 16);
}

function parseMap(bytes) {
  const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('地图明文必须是 UTF-8 JSON 对象');
  }
  return map;
}

export function encodeMap(bytes) {
  const map = parseMap(bytes);
  if (typeof map.ver !== 'string' || !map.ver.startsWith('5.')) {
    throw new Error('需要 5.x 地图格式字段 ver，旧的模拟明文可用 build-map.mjs 从原布局重新生成');
  }
  for (const field of ['mapDataList', 'mapLineList', 'mapAreaList']) {
    if (!Array.isArray(map[field])) throw new Error(`地图缺少数组 ${field}`);
  }
  const cipher = createCipheriv('aes-128-ecb', mapKey(), null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64');
}

export function decodeMap(bytes) {
  // Lothar's multipart reader trims each line and joins the Base64 fragments.
  const encoded = bytes.toString('utf8').trim().split(/\r\n?|\n/)
    .map(line => line.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''))
    .join('');
  const remainder = encoded.length % 4;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || remainder === 1 || (encoded.endsWith('=') && remainder !== 0)) {
    throw new Error('整图包的 Base64 格式无效');
  }
  const ciphertext = Buffer.from(encoded, 'base64');
  if (ciphertext.length % 16 !== 0) {
    throw new Error('无效的整图包，请使用地图文件本身');
  }
  const decipher = createDecipheriv('aes-128-ecb', mapKey(), null);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    parseMap(plain);
  } catch {
    throw new Error('未解出有效的地图 JSON，请核对文件、站点编码口令及版本');
  }
  return plain;
}

async function main() {
  const [action, source, destination, ...extra] = process.argv.slice(2);
  if (!['encode', 'decode'].includes(action) || !source || !destination || extra.length) {
    throw new Error('用法：node map-codec.mjs <encode|decode> <输入文件> <新输出文件>');
  }
  const bytes = await readFile(source);
  const result = action === 'encode' ? encodeMap(bytes) : decodeMap(bytes);
  await writeNewFile(destination, result);
  console.log(JSON.stringify({ action, output: destination }));
}

if (import.meta.main) main().catch(error => {
  console.error(`地图编解码失败：${error.message}`);
  process.exitCode = 1;
});
