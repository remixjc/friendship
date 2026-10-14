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
    const data = options.body ? JSON.parse(options.body) : null;
    const parsed = new URL(url);
    upstreamRequests.push({ url: parsed.pathname, query: Object.fromEntries(parsed.searchParams), data, headers: Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value])) });
    if (parsed.pathname.includes('timeCard')) {
      const user = options.headers['X-Token'].slice('private-token-'.length);
      const summary = parsed.pathname.endsWith('Summary');
      return new Response(JSON.stringify({ msgCode: 200, content: {
        totalCount: 1, body: summary
          ? [{ employeeId: { valueId: `employee-${user}` }, attendanceName: '出勤工时', totalNum: '43:01', calculateUnit: { valueName: '小时' } }]
          : [{ scheduleDate: `${JSON.parse(parsed.searchParams.get('dateRange')).beginDate.slice(0, 7)}-14`, employeeId: `employee-${user}`, scheduleName: user,
            timeAttendance: [{ attendanceName: '打卡', beginDateTime: null, endDateTime: null }] }],
      } }));
    }
    const user = data?.data?.username;
    return new Response(JSON.stringify(url.endsWith('/login') ? {
      content: { body: { token: `private-token-${user}`, employeeId: { valueId: `employee-${user}` }, openId: 'openid-from-server', employeeName: '示例员工' } },
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
  return { store, admin, client, apiBaseUrl, upstreamRequests, origin, dispatch, attendance, scheduler };
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
  assert.equal(request.headers['x-token'], 'private-token-attendance-user');
  assert.equal(request.data.data.employeeId, 'employee-attendance-user');
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

test('考勤查询需要登录和个人配置，月份页码校验且不接受客户端员工 ID', async t => {
  const f = await fixture(t);
  assert.equal((await f.client().request('/api/attendance/records?month=2026-10')).status, 401);
  assert.equal((await f.admin.request('/api/attendance/records?month=2026-10')).status, 400);
  await f.admin.request('/api/settings', 'PUT', { apiBaseUrl: f.apiBaseUrl, username: 'personal-account', password: 'test-only-password', openId: 'personal-openid' });
  for (const query of ['month=2026-13', 'month=bad', 'month=2026-10&page=1.5', 'month=2026-10&pageSize=51', 'month=2026-10&summaryPage=0']) {
    assert.equal((await f.admin.request(`/api/attendance/records?${query}`)).status, 400);
  }
  const result = await f.admin.request('/api/attendance/records?month=2026-10&employeeId=999&userId=other-user');
  assert.equal(result.status, 200);
  assert.equal(result.data.records.items[0].scheduleName, 'personal-account');
  assert.equal(result.data.summary.items[0].total, '43:01');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(result.data).includes('private-token'));
  assert.ok(!JSON.stringify(result.data).includes('test-only-password'));
  const queryRequests = f.upstreamRequests.filter(req => req.url.includes('timeCard'));
  assert.equal(queryRequests.length, 2);
  assert.ok(queryRequests.every(req => req.query.employeeId === 'employee-personal-account'));
  assert.equal((await f.admin.request('/api/runs')).data.total, 0);
});

test('成员只能查询自己考勤账号的记录，管理员也无法通过参数查询其他用户', async t => {
  const f = await fixture(t);
  await f.admin.request('/api/settings', 'PUT', { apiBaseUrl: f.apiBaseUrl, username: 'admin-attendance', password: 'test-admin-upstream', openId: 'test-openid' });
  await f.admin.request('/api/users', 'POST', { username: 'member', password: 'member-test-password', role: 'user' });
  const member = f.client();
  await member.request('/api/auth/login', 'POST', { username: 'member', password: 'member-test-password' });
  await member.request('/api/settings', 'PUT', { apiBaseUrl: f.apiBaseUrl, username: 'member-attendance', password: 'test-member-upstream', openId: 'test-openid' });
  const own = await member.request('/api/attendance/records?month=2026-10&employeeId=employee-admin-attendance');
  assert.equal(own.status, 200);
  assert.equal(own.data.records.items[0].scheduleName, 'member-attendance');
  const admin = await f.admin.request('/api/attendance/records?month=2026-10&employeeId=employee-member-attendance');
  assert.equal(admin.data.records.items[0].scheduleName, 'admin-attendance');
});

test('考勤查询拒绝同用户并发，但不占用调度锁；失败后允许重新查询', async t => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.attendance.report = () => new Promise(resolve => { release = resolve; started(); });
  const first = f.admin.request('/api/attendance/records?month=2026-10');
  await ready;
  assert.equal(f.scheduler.busy, 0);
  assert.equal((await f.admin.request('/api/attendance/records?month=2026-10')).status, 409);
  release({ month: '2026-10' });
  assert.equal((await first).status, 200);
  f.attendance.report = async () => { throw new Error('secret internal error'); };
  assert.equal((await f.admin.request('/api/attendance/records?month=2026-10')).status, 500);
  f.attendance.report = async () => ({ month: '2026-10' });
  assert.equal((await f.admin.request('/api/attendance/records?month=2026-10')).status, 200);
});

test('查询等待期间注销会话后，不向已注销会话返回考勤结果', async t => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.attendance.report = () => new Promise(resolve => { release = resolve; started(); });
  const first = f.admin.request('/api/attendance/records?month=2026-10');
  await ready;
  await f.admin.request('/api/auth/logout', 'POST');
  release({ privateData: 'must-not-be-returned' });
  const result = await first;
  assert.equal(result.status, 401);
  assert.ok(!JSON.stringify(result.data).includes('must-not-be-returned'));
});
