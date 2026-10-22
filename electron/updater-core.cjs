const crypto = require('node:crypto');
const path = require('node:path');

const APP_NAME = 'Chiikawa Corner.app';
function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('지원하지 않는 버전 형식이에요.');
  const parts = version.split('.').map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n))) throw new Error('잘못된 버전이에요.');
  return parts;
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function validateUrl(value, allowHttp = false) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowHttp && local && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new Error('안전한 업데이트 주소가 아니에요.');
  return url;
}
function verifyManifest(envelope, publicKey, { currentVersion, allowHttp = false } = {}) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || envelope.payload.length > 32000) throw new Error('업데이트 정보가 올바르지 않아요.');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || !crypto.verify(null, payload, publicKey, signature)) throw new Error('업데이트 서명을 확인할 수 없어요.');
  const data = JSON.parse(payload.toString('utf8'));
  if (data.schema !== 1 || data.appId !== 'com.corner.chiikawa' || data.platform !== 'darwin' || data.arch !== 'universal') throw new Error('이 앱에 맞는 업데이트가 아니에요.');
  versionParts(data.version);
  if (currentVersion) versionParts(currentVersion);
  validateUrl(data.url, allowHttp);
  if (!Number.isSafeInteger(data.size) || data.size <= 0 || data.size > 1024 ** 3 || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('업데이트 파일 정보가 올바르지 않아요.');
  if (data.releaseNotes !== undefined && (typeof data.releaseNotes !== 'string' || data.releaseNotes.length > 6000)) throw new Error('업데이트 설명이 너무 길어요.');
  return data;
}
function inspectArchiveEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100000) throw new Error('빈 업데이트 파일이에요.');
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry || entry.includes('\\') || /[\x00-\x1f\x7f]/.test(entry) || entry.startsWith('/') || entry.split('/').some((p) => p === '..' || p === '.') || (entry !== APP_NAME && !entry.startsWith(`${APP_NAME}/`)) || seen.has(entry)) throw new Error('업데이트 압축 파일의 경로가 안전하지 않아요.');
    seen.add(entry);
  }
}
function inspectSymlink(entry, target) {
  if (!target || path.posix.isAbsolute(target) || target.includes('\\') || /[\x00-\x1f]/.test(target)) throw new Error('업데이트 링크가 안전하지 않아요.');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), target));
  if (resolved !== APP_NAME && !resolved.startsWith(`${APP_NAME}/`)) throw new Error('업데이트 링크가 앱 밖을 가리켜요.');
}
module.exports = { APP_NAME, compareVersions, verifyManifest, validateUrl, inspectArchiveEntries, inspectSymlink };
