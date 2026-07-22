import crypto from 'node:crypto';
import argon2 from 'argon2';

export const AUTH_COOKIE = 'seedance_auth';
export const AUTH_TTL_MS = 8 * 60 * 60 * 1000;

export async function hashPassword(password) {
  validatePassword(password);
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash, password) {
  try { return await argon2.verify(hash, String(password || '')); } catch { return false; }
}

export function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 10 || value.length > 128 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw publicError(400, '密码至少10位，并同时包含字母和数字');
  }
  return value;
}

export function newToken() { return crypto.randomBytes(32).toString('base64url'); }
export function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
export function keyFingerprint(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }

export function cookieHeader(token, secure = false) {
  return `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookieHeader(secure = false) {
  return `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function parseCookie(req, name = AUTH_COOKIE) {
  for (const item of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function createPromptCipher(secret) {
  const key = crypto.createHash('sha256').update(String(secret || crypto.randomUUID())).digest();
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return { ciphertext: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    decrypt(payload) {
      if (!payload?.ciphertext) return '';
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}

export function publicError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.code = code;
  return error;
}
