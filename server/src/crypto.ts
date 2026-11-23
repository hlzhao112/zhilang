import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

function key(): Buffer {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32));
  const raw = readFileSync(file);
  return raw.length === 32 ? raw : scryptSync(raw.toString('hex'), 'yard-key', 32);
}

export function seal(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function openSeal(payload: string): string {
  if (!payload) return '';
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, 'hex');
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

let tokenKey: Buffer | null = null;
function signingKey(): Buffer {
  if (!tokenKey) tokenKey = scryptSync(key(), 'yard-session', 32);
  return tokenKey;
}

export function signSession(userId: number, name: string): string {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const body = Buffer.from(JSON.stringify({ userId, name, exp })).toString('base64url');
  const mac = createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined): { userId: number; name: string } | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as { userId: number; name: string; exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    return { userId: data.userId, name: data.name };
  } catch {
    return null;
  }
}
