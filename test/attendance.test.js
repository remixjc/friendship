import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttendance } from '../src/attendance.js';
import { defaults } from '../src/config.js';

const config = { ...defaults, username: 'test-user', password: 'only-test-password', openId: 'test-openid' };
const response = json => new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } });
const loginResponse = { content: { body: { token: 'test-token', employeeId: { valueId: 42 }, openId: 'server-openid', employeeName: '测试员工' } } };

test('模拟不调用任何外部接口', async () => {
  const api = createAttendance(() => { throw new Error('Unexpected network'); });
  const result = await api.punch(config, true);
  assert.match(result.message, /未调用考勤接口/);
});

test('保留原项目登录报文、X-Token 和打卡字段，核对上游成功标记', async () => {
  const requests = [];
  const api = createAttendance(async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return response(requests.length === 1 ? loginResponse : { code: 0, success: true });
  });
  const result = await api.punch(config, false);
  assert.equal(result.employeeName, '测试员工');
  assert.equal(requests[0].url, `${config.apiBaseUrl}/api/system/login`);
  assert.deepEqual(requests[0].body, { data: { company: 'wanji', username: 'test-user', password: 'only-test-password', source: 5, openId: 'test-openid' } });
  const punch = requests[1];
  assert.equal(punch.headers['X-Token'], 'test-token');
  assert.equal(punch.redirect, 'error');
  assert.equal(punch.body.data.employeeId, '42');
  assert.equal(punch.body.data.extUserDevice, 'server-openid');
  assert.equal(punch.body.data.punchWay, 2);
  assert.ok(Number(punch.body.data.longitude) >= config.longitude);
  assert.ok(Number(punch.body.data.longitude) <= config.longitude + config.coordinateJitter);
  assert.ok(config.sites.includes(punch.body.data.punchSite));
});

test('接口拒绝不能记为成功，不明响应或网络失败记为待核对', async () => {
  for (const [reply, outcome] of [[{ code: 403 }, 'failed'], [{ success: false }, 'failed'], [{ content: {} }, 'unknown']]) {
    let count = 0;
    const api = createAttendance(async () => response(++count === 1 ? loginResponse : reply));
    await assert.rejects(() => api.punch(config, false), error => error.outcome === outcome);
  }
  let count = 0;
  const api = createAttendance(async () => {
    if (++count === 1) return response(loginResponse);
    throw new Error('contains-secret-token');
  });
  await assert.rejects(() => api.punch(config, false), error => error.outcome === 'unknown' && !error.message.includes('secret'));
});

test('上游超时可终止请求且不记录敏感异常内容', async () => {
  const api = createAttendance(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('secret')), { once: true });
    const hold = setTimeout(() => reject(new Error('unexpected timeout')), 1000);
    options.signal.addEventListener('abort', () => clearTimeout(hold), { once: true });
  }), 20);
  await assert.rejects(() => api.login(config), /上游请求失败或超时/);
});

test('工作日识别调休、手动覆盖，接口失败默认跳过', async () => {
  let count = 0;
  const api = createAttendance(async url => {
    count++;
    assert.equal(new URL(url).searchParams.get('date'), '20261010');
    return response({ data: { list: [{ workday: 1 }] } });
  });
  const holiday = { ...config, workdayMode: 'holiday' };
  assert.equal((await api.workday(holiday, '2026-10-10')).workday, true);
  assert.equal((await api.workday({ ...holiday, workdayOverrides: { '2026-10-10': 0 } }, '2026-10-10')).workday, false);
  assert.equal(count, 1);
  const down = createAttendance(async () => { throw new Error('offline'); });
  assert.equal((await down.workday(holiday, '2026-10-14')).workday, false);
  assert.equal((await down.workday({ ...holiday, holidayFallback: 'weekdays' }, '2026-10-14')).workday, true);
});
