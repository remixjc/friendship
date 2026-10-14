import { randomBytes, scrypt, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './config.js';

const derive = promisify(scrypt);
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export function validateAccount(input) {
  if (typeof input?.username !== 'string' || !/^[a-zA-Z0-9_.-]{3,40}$/.test(input.username)) {
    throw new AppError('登录用户名需为 3～40 位字母、数字、点、下划线或短横线');
  }
  validatePassword(input.password);
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 60)) {
    throw new AppError('显示名称不能超过 60 字');
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new AppError('登录密码长度必须为 10～128 位');
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [, salt, expected] = encoded.split(':');
  const actual = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function createVault(dataDir, envKey) {
  let key;
  if (envKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(envKey)) throw new Error('ENCRYPTION_KEY 必须为 64 位十六进制字符串');
    key = Buffer.from(envKey, 'hex');
  } else {
    const path = join(dataDir, 'secrets.key');
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    const raw = readFileSync(path, 'utf8').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error('数据卷 secrets.key 无效');
    key = Buffer.from(raw, 'hex');
  }
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join('.');
    },
    decrypt(value) {
      if (!value) return '';
      const [iv, tag, payload] = value.split('.');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      cipher.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(payload, 'hex')), cipher.final()]).toString('utf8');
    },
  };
}
