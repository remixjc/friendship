import { createHash } from 'node:crypto';
import { AppError } from './config.js';

export class UpstreamAuthError extends AppError {
  constructor() { super('考勤登录状态已失效，请重新验证账号', 502); }
}

export function credentialFingerprint(config) {
  return createHash('sha256').update(JSON.stringify([
    config.apiBaseUrl, config.company, config.username, config.password, config.source, config.openId,
  ])).digest('hex');
}

function expiryFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch { /* Opaque tokens have no local expiry; wait for an explicit upstream rejection. */ }
  return null;
}

export function createUpstreamSessions(store, clock = Date.now) {
  const inFlight = new Map();
  return {
    async get(config, login, rejectedToken = null) {
      const key = credentialFingerprint(config);
      const id = config.userId || key;
      const cached = store?.loadUpstreamSession(id);
      if (cached && cached.fingerprint === key && (cached.expiresAt === null || cached.expiresAt > clock())
        && cached.account.token !== rejectedToken) return cached.account;
      const lockKey = `${id}:${key}`;
      if (inFlight.has(lockKey)) return inFlight.get(lockKey);
      const promise = Promise.resolve().then(async () => {
        const account = await login();
        store?.saveUpstreamSession(id, { fingerprint: key, account, expiresAt: expiryFromToken(account.token) });
        return account;
      });
      inFlight.set(lockKey, promise);
      try { return await promise; }
      finally { inFlight.delete(lockKey); }
    },
  };
}
