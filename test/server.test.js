import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createStore } from '../src/store.js';
import { createAttendance } from '../src/attendance.js';
import { createScheduler } from '../src/scheduler.js';
import { createHttpServer } from '../src/server.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'friends-ship-api-'));
  const store = createStore(dir);
  const upstreamRequests = [];
  const apiBaseUrl = 'https://mock-attendance.example';
  const attendance = createAttendance(async (url, options) => {
    const data = JSON.parse(options.body);
    upstreamRequests.push({ url: new URL(url).pathname, data, headers: Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value])) });
    return new Response(JSON.stringify(url.endsWith('/login') ? {
      content: { body: { token: 'private-token', employeeId: { valueId: 'e-1' }, openId: 'openid-from-server', employeeName: '示例员工' } },
    } : { code: 0, success: true }), { headers: { 'Content-Type': 'application/json' } });
  });
  const scheduler = createScheduler(store, attendance);
  const server = await createHttpServer({ store, scheduler, attendance, env: {} });
  const origin = 'http://localhost:3000';
  // Exercise the production HTTP handler entirely in process: no sockets or outside services.
  const handler = server.listeners('request')[0];
  async function dispatch(path, method, body, headers) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: path, method, headers, socket: { remoteAddress: '127.0.0.1' } });
    const responseHeaders = new Headers();
    let status = 200, output = '';
    const res = {
      headersSent: false,
      setHeader(key, value) { responseHeaders.set(key, value); },
      writeHead(code, values) {
        status = code;
        this.headersSent = true;
        for (const [key, value] of Object.entries(values)) responseHeaders.set(key, value);
      },
      end(value) { output = String(value ?? ''); },
      destroy() { throw new Error('Unexpected response destruction'); },
    };
    await handler(req, res);
    return { status, output, headers: responseHeaders };
  }
  t.after(async () => {
    await scheduler.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function client() {
    let cookie = '', csrf = '';
    return {
      async request(path, method = 'GET', body, extraHeaders = {}) {
        const headers = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, Host: 'localhost:3000', ...extraHeaders }).map(([key, value]) => [key.toLowerCase(), value]));
        const response = await dispatch(path, method, body, headers);
        const data = JSON.parse(response.output);
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        if (data.csrf) csrf = data.csrf;
        return { status: response.status, data, headers: response.headers };
      },
    };
  }
  const admin = client();
  const setup = await admin.request('/api/auth/setup', 'POST', { username: 'admin', password: 'test-admin-password', displayName: '管理员' });
  assert.equal(setup.status, 200);
  return { store, admin, client, apiBaseUrl, upstreamRequests, origin, dispatch };
}

test('首次初始化、登录、退出、鉴权和 CSRF 校验', async t => {
  const f = await fixture(t);
  const anonymous = f.client();
  assert.equal((await anonymous.request('/api/settings')).status, 401);
  assert.equal((await anonymous.request('/api/auth/setup', 'POST', { username: 'other', password: 'test-password' })).status, 409);
  const csrf = await f.admin.request('/api/settings', 'PUT', {}, { 'X-CSRF-Token': 'invalid' });
  assert.equal(csrf.status, 403);
  assert.equal((await f.admin.request('/api/settings', 'PUT', {}, { Origin: 'https://evil.example' })).status, 403);
  const status = await f.admin.request('/api/auth/status');
  assert.equal(status.data.user.role, 'admin');
  assert.ok(status.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await f.admin.request('/api/auth/logout', 'POST')).status, 200);
  assert.equal((await f.admin.request('/api/settings')).status, 401);
  assert.equal((await anonymous.request('/api/auth/login', 'POST', { username: 'admin', password: 'incorrect' })).status, 401);
  const login = await anonymous.request('/api/auth/login', 'POST', { username: 'ADMIN', password: 'test-admin-password' });
  assert.equal(login.status, 200);
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
});

test('完整流程：配置、加密、考勤登录、模拟、真实打卡、历史和日志', async t => {
  const f = await fixture(t);
  const input = { apiBaseUrl: f.apiBaseUrl, username: 'attendance-user', password: 'test-attendance-password', openId: 'client-openid', dryRun: false };
  const saved = await f.admin.request('/api/settings', 'PUT', input);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.hasPassword, true);
  assert.equal(saved.data.password, undefined);
  const row = f.store.db.prepare('SELECT config,password FROM settings').get();
  assert.ok(!JSON.stringify(row).includes(input.password));
  const login = await f.admin.request('/api/attendance/test-login', 'POST', {});
  assert.equal(login.status, 200);
  assert.equal(login.data.employeeName, '示例员工');
  assert.ok(!JSON.stringify(login.data).includes('private-token'));
  const before = f.upstreamRequests.length;
  const simulated = await f.admin.request('/api/attendance/run', 'POST', { dryRun: true });
  assert.equal(simulated.data.status, 'simulated');
  assert.equal(f.upstreamRequests.length, before);
  const real = await f.admin.request('/api/attendance/run', 'POST', { dryRun: false });
  assert.equal(real.data.status, 'success');
  assert.equal(f.upstreamRequests.length, before + 2);
  const request = f.upstreamRequests.at(-1);
  assert.equal(request.headers['x-token'], 'private-token');
  assert.equal(request.data.data.employeeId, 'e-1');
  const runs = await f.admin.request('/api/runs');
  assert.equal(runs.data.total, 2);
  assert.ok(!JSON.stringify(runs.data).includes(input.password));
  const logs = await f.admin.request('/api/logs');
  assert.ok(!JSON.stringify(logs.data).includes('private-token'));
  assert.ok(!JSON.stringify(logs.data).includes(input.password));
  assert.equal((await f.admin.request('/api/dashboard')).status, 200);
});

test('多用户配置与记录相互隔离；成员不能管理用户，停用立即撤销会话', async t => {
  const f = await fixture(t);
  const created = await f.admin.request('/api/users', 'POST', { username: 'member', password: 'member-test-password', role: 'user' });
  assert.equal(created.status, 201);
  const member = f.client();
  assert.equal((await member.request('/api/auth/login', 'POST', { username: 'member', password: 'member-test-password' })).status, 200);
  assert.equal((await member.request('/api/users')).status, 403);
  await member.request('/api/settings', 'PUT', { username: 'member-attendance' });
  assert.equal((await f.admin.request('/api/settings')).data.username, '');
  await member.request('/api/attendance/run', 'POST', { dryRun: true });
  assert.equal((await member.request('/api/runs')).data.total, 1);
  assert.equal((await f.admin.request('/api/runs')).data.total, 0);
  const adminId = (await f.admin.request('/api/auth/status')).data.user.id;
  assert.equal((await f.admin.request(`/api/users/${adminId}`, 'PATCH', { disabled: true })).status, 400);
  assert.equal((await f.admin.request(`/api/users/${created.data.id}`, 'PATCH', { disabled: true })).status, 200);
  assert.equal((await member.request('/api/settings')).status, 401);
  assert.equal((await member.request('/api/auth/login', 'POST', { username: 'member', password: 'member-test-password' })).status, 401);
});

test('修改控制台密码撤销所有旧会话', async t => {
  const f = await fixture(t);
  const second = f.client();
  await second.request('/api/auth/login', 'POST', { username: 'admin', password: 'test-admin-password' });
  const changed = await f.admin.request('/api/auth/password', 'POST', { currentPassword: 'test-admin-password', newPassword: 'updated-test-password' });
  assert.equal(changed.status, 200);
  assert.equal((await second.request('/api/settings')).status, 401);
  assert.equal((await f.admin.request('/api/settings')).status, 200);
  assert.equal((await second.request('/api/auth/login', 'POST', { username: 'admin', password: 'updated-test-password' })).status, 200);
});

test('旧配置导入与删除密码，真实执行模式有完整校验', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.request('/api/settings', 'PUT', { enabled: true, dryRun: false })).status, 400);
  assert.equal((await f.admin.request('/api/attendance/run', 'POST', { dryRun: false })).status, 400);
  const imported = await f.admin.request('/api/settings/import', 'POST', {
    times: { amStart: '08:00', amEnd: '08:20', pmStart: '18:30', pmEnd: '19:00', freshDate: '16:00' },
    userInfo: [{ data: { company: 'example', username: 'imported', password: 'test-legacy-password', source: 5, openId: 'test-imported-id' } }],
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.freshDate, '00:05');
  assert.equal(imported.data.hasPassword, true);
  assert.equal(imported.data.enabled, false);
  const clear = await f.admin.request('/api/settings', 'PUT', { clearPassword: true });
  assert.equal(clear.data.hasPassword, false);
});

test('health 与静态页面可用，路径遍历和未知接口无法读取文件', async t => {
  const f = await fixture(t);
  const health = await f.client().request('/api/health');
  assert.equal(health.data.status, 'ok');
  const page = await f.dispatch('/', 'GET', undefined, {});
  assert.equal(page.status, 200);
  assert.ok(page.output.includes('FriendsShip'));
  for (const path of ['/src/store.js', '/%2e%2e/package.json', '/data/secrets.key']) {
    assert.equal((await f.dispatch(path, 'GET', undefined, {})).status, 404);
  }
  assert.equal((await f.admin.request('/api/unknown')).status, 404);
});
