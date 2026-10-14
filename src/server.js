import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, defaults, importLegacy, localClock, validateSettings } from './config.js';
import { hashPassword, newToken, tokenHash, validateAccount, validatePassword, verifyPassword } from './security.js';
import { reportQuery } from './reports.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const sessionDuration = 7 * 86400000;

export async function createHttpServer({ store, scheduler, attendance, env = process.env }) {
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  const rateLimits = new Map();
  const reportRequests = new Set();
  let authInFlight = 0;
  function rateLimit(key, max, window = 60000) {
    const now = Date.now();
    if (rateLimits.size > 10000) {
      for (const [id, value] of rateLimits) if (value.until < now) rateLimits.delete(id);
      if (rateLimits.size > 10000) throw new AppError('请求繁忙，请稍后再试', 429);
    }
    let entry = rateLimits.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + window }; rateLimits.set(key, entry); }
    if (++entry.count > max) throw new AppError('请求过于频繁，请稍后再试', 429);
  }
  async function passwordOperation(fn) {
    if (authInFlight >= 8) throw new AppError('登录请求繁忙，请稍后再试', 429);
    authInFlight++;
    try { return await fn(); }
    finally { authInFlight--; }
  }
  function json(res, status, value, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  }
  function cookie(value, age = sessionDuration / 1000) {
    return `fs_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
  }
  function authenticate(req) {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('fs_session='))?.slice(11);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = store.db.prepare(`SELECT s.*,u.disabled FROM sessions s JOIN users u ON s.user_id=u.id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), Date.now());
    if (!row || row.disabled) return null;
    return { ...row, user: store.getUser(row.user_id) };
  }
  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('禁止跨站请求', 403);
    const origin = req.headers.origin;
    if (!origin) return; // Non-browser clients must still supply the session CSRF token.
    const expected = env.APP_ORIGIN || `${env.COOKIE_SECURE === 'true' ? 'https' : 'http'}://${req.headers.host}`;
    if (origin !== expected) throw new AppError('请求来源不匹配，请检查 APP_ORIGIN 配置', 403);
  }
  async function readBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请求必须为 application/json', 415);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new AppError('请求内容超过 64KB', 413);
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch { throw new AppError('无效的 JSON 请求'); }
  }
  function startSession(user, res) {
    const token = newToken(), csrf = newToken();
    store.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)')
      .run(tokenHash(token), user.id, csrf, Date.now() + sessionDuration);
    return json(res, 200, { user: store.publicUser(user), csrf }, { 'Set-Cookie': cookie(token) });
  }
  async function saveConfig(id, input) {
    return scheduler.withUser(id, async () => {
      const previous = store.settings(id);
      if (Object.hasOwn(input, 'clearPassword') && typeof input.clearPassword !== 'boolean') throw new AppError('clearPassword 格式错误');
      if (input.clearPassword && input.password) throw new AppError('不能同时删除和修改考勤密码');
      const hasPassword = input.clearPassword ? false : Boolean(input.password || previous.hasPassword);
      const config = validateSettings(input, previous, hasPassword, env.ALLOW_HTTP_UPSTREAM === 'true');
      // Only persist the declared config fields; never persist plaintext credentials.
      const clean = Object.fromEntries(Object.keys(defaults).map(key => [key, config[key]]));
      store.saveSettings(id, clean, input.password, input.clearPassword);
      store.log(id, 'info', 'settings', '个人配置已更新，当日计划将在下一次刷新时重新生成');
      return store.settings(id);
    });
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (method === 'GET' && assets[path]) {
        const [name, type] = assets[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(join(publicDir, name)));
      }
      if (!path.startsWith('/api/')) throw new AppError('页面不存在', 404);
      rateLimit(`general:${req.socket.remoteAddress}`, 600);
      if (path === '/api/health' && method === 'GET') {
        store.db.prepare('SELECT 1').get();
        return json(res, 200, { status: 'ok' });
      }
      if (path === '/api/auth/status' && method === 'GET') {
        const session = authenticate(req);
        return json(res, 200, {
          initialized: store.userCount() > 0,
          user: session ? store.publicUser(session.user) : null,
          csrf: session?.csrf || null,
        });
      }
      if (method !== 'GET') checkOrigin(req);
      if (['/api/auth/setup', '/api/auth/login'].includes(path) && method === 'POST') {
        rateLimit(`auth:${req.socket.remoteAddress}`, 10, 15 * 60000);
        const input = await readBody(req);
        if (path.endsWith('/setup')) {
          if (store.userCount()) throw new AppError('系统已初始化', 409);
          validateAccount(input);
          const hash = await passwordOperation(() => hashPassword(input.password));
          const user = store.createUser(input, hash, 'admin', true);
          store.log(user.id, 'info', 'account', '首个管理员已创建');
          return startSession(user, res);
        }
        if (typeof input.username !== 'string' || input.username.length > 40 || typeof input.password !== 'string') throw new AppError('账号或密码错误', 401);
        const user = store.findUser(input.username);
        const valid = await passwordOperation(() => verifyPassword(input.password, user?.password_hash || dummyHash));
        if (!valid || !user || user.disabled) throw new AppError('账号或密码错误', 401);
        store.log(user.id, 'info', 'login', '用户登录成功');
        return startSession(user, res);
      }
      const session = authenticate(req);
      if (!session) throw new AppError('请先登录', 401);
      const userId = session.user_id;
      if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new AppError('请求验证失败，请刷新页面后重试', 403);
      if (path === '/api/auth/logout' && method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/auth/password' && method === 'POST') {
        const input = await readBody(req);
        validatePassword(input.newPassword);
        rateLimit(`password:${userId}`, 5, 15 * 60000);
        if (!await passwordOperation(() => verifyPassword(input.currentPassword, session.user.password_hash))) throw new AppError('当前密码错误');
        const hash = await passwordOperation(() => hashPassword(input.newPassword));
        store.transaction(() => {
          store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, userId);
          store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        });
        store.log(userId, 'info', 'account', '登录密码已修改，所有旧会话已失效');
        return startSession(store.getUser(userId), res);
      }
      if (path === '/api/settings' && method === 'GET') return json(res, 200, store.settings(userId));
      if (path === '/api/settings' && method === 'PUT') return json(res, 200, await saveConfig(userId, await readBody(req)));
      if (path === '/api/settings/import' && method === 'POST') {
        return json(res, 200, await saveConfig(userId, importLegacy(await readBody(req))));
      }
      if (path === '/api/dashboard' && method === 'GET') {
        const config = store.settings(userId);
        let plan = store.plan(userId, localClock(new Date(), config.timezone).day);
        try { plan = await scheduler.withUser(userId, () => scheduler.ensurePlan(userId)); }
        catch (error) { if (error.status !== 409) throw error; }
        const clock = localClock(new Date(), config.timezone);
        const stats = store.db.prepare(`SELECT count(*) AS total,
          sum(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
          sum(CASE WHEN status IN ('failed','unknown') THEN 1 ELSE 0 END) AS failed,
          sum(CASE WHEN status='simulated' THEN 1 ELSE 0 END) AS simulated
          FROM runs WHERE user_id=? AND day=?`).get(userId, clock.day);
        return json(res, 200, { clock, timezone: config.timezone, enabled: config.enabled, dryRun: config.dryRun,
          plan, stats, runs: store.runs(userId, 6), hasPassword: config.hasPassword });
      }
      if (path === '/api/runs' && method === 'GET') {
        const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page'), 10) || 1));
        const total = store.db.prepare('SELECT count(*) AS n FROM runs WHERE user_id=?').get(userId).n;
        return json(res, 200, { items: store.runs(userId, 20, (page - 1) * 20), page, total });
      }
      if (path === '/api/logs' && method === 'GET') return json(res, 200, { items: store.logs(userId) });
      if (path === '/api/attendance/quota' && method === 'GET') {
        rateLimit(`quota:${userId}`, 12);
        const key = `quota:${userId}`;
        if (reportRequests.has(key)) throw new AppError('年假查询正在进行，请稍后再试', 409);
        reportRequests.add(key);
        try {
          const result = await attendance.quota(store.settings(userId, true));
          if (store.getUser(userId)?.disabled || !authenticate(req)) throw new AppError('登录状态已失效，请重新登录', 401);
          return json(res, 200, result);
        } finally { reportRequests.delete(key); }
      }
      if (path === '/api/attendance/records' && method === 'GET') {
        const query = reportQuery({
          month: url.searchParams.get('month') ?? localClock(new Date(), store.settings(userId).timezone).day.slice(0, 7),
          page: Number(url.searchParams.get('page') ?? 1),
          pageSize: Number(url.searchParams.get('pageSize') ?? 20),
          summaryPage: Number(url.searchParams.get('summaryPage') ?? 1),
        });
        rateLimit(`report:${userId}`, 12);
        if (reportRequests.has(userId)) throw new AppError('考勤查询正在进行，请稍后再试', 409);
        reportRequests.add(userId);
        try {
          // Read-only queries use their own lock so they cannot delay scheduled punches.
          const result = await attendance.report(store.settings(userId, true), query);
          if (store.getUser(userId)?.disabled || !authenticate(req)) throw new AppError('登录状态已失效，请重新登录', 401);
          return json(res, 200, result);
        } finally { reportRequests.delete(userId); }
      }
      if (path === '/api/attendance/test-login' && method === 'POST') {
        rateLimit(`upstream:${userId}`, 6);
        const result = await scheduler.withUser(userId, () => attendance.testLogin(store.settings(userId, true)));
        store.log(userId, 'info', 'test', '考勤账号登录测试成功');
        return json(res, 200, { employeeName: result.employeeName, message: '登录成功，未提交打卡' });
      }
      if (path === '/api/attendance/run' && method === 'POST') {
        rateLimit(`upstream:${userId}`, 6);
        const input = await readBody(req);
        if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new AppError('dryRun 格式错误');
        return json(res, 200, await scheduler.manual(userId, input.dryRun !== false));
      }
      if (path.startsWith('/api/users')) {
        if (session.user.role !== 'admin') throw new AppError('需要管理员权限', 403);
        if (path === '/api/users' && method === 'GET') return json(res, 200, { items: store.users().map(store.publicUser) });
        if (path === '/api/users' && method === 'POST') {
          if (store.userCount() >= 100) throw new AppError('用户数量已达上限');
          const input = await readBody(req);
          validateAccount(input);
          if (!['admin', 'user'].includes(input.role)) throw new AppError('无效的用户角色');
          const hash = await passwordOperation(() => hashPassword(input.password));
          const user = store.createUser(input, hash, input.role);
          store.log(userId, 'info', 'users', `创建用户 ${user.username}`);
          return json(res, 201, store.publicUser(user));
        }
        const targetId = path.match(/^\/api\/users\/([a-f0-9-]+)$/)?.[1];
        if (targetId && method === 'PATCH') {
          const target = store.getUser(targetId);
          if (!target) throw new AppError('用户不存在', 404);
          const input = await readBody(req);
          if (typeof input.disabled !== 'boolean') throw new AppError('disabled 必须为布尔值');
          if (userId === targetId && input.disabled) throw new AppError('不能停用当前登录账号');
          return await scheduler.withUser(targetId, async () => {
            store.transaction(() => {
              if (input.disabled && target.role === 'admin'
                && store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n <= 1) throw new AppError('至少保留一个有效管理员');
              store.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(Number(input.disabled), targetId);
              if (input.disabled) {
                store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
                store.db.prepare('DELETE FROM upstream_sessions WHERE user_id=?').run(targetId);
              }
            });
            store.log(userId, 'info', 'users', `${input.disabled ? '停用' : '启用'}用户 ${target.username}`);
            return json(res, 200, store.publicUser(store.getUser(targetId)));
          });
        }
      }
      throw new AppError('接口不存在', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof AppError ? error.status : 500;
      if (status === 500) console.error('请求处理失败', error.name);
      json(res, status, { error: status === 500 ? '服务器内部错误' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
