import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttendance } from '../src/attendance.js';
import { defaults, legacyHolidayUrl } from '../src/config.js';

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
  const holiday = { ...config, holidayUrl: legacyHolidayUrl, workdayMode: 'holiday' };
  assert.equal((await api.workday(holiday, '2026-10-10')).workday, true);
  assert.equal((await api.workday({ ...holiday, workdayOverrides: { '2026-10-10': 0 } }, '2026-10-10')).workday, false);
  assert.equal(count, 1);
  const down = createAttendance(async () => { throw new Error('offline'); });
  assert.equal((await down.workday(holiday, '2026-10-14')).workday, false);
  assert.equal((await down.workday({ ...holiday, holidayFallback: 'weekdays' }, '2026-10-14')).workday, true);
});

test('msgCode 兼容登录和真实打卡成功，冲突失败标记优先', async () => {
  let count = 0;
  const api = createAttendance(async () => response(++count === 1
    ? { ...loginResponse, msgCode: 200 } : { msgCode: 200 }));
  assert.match((await api.punch(config, false)).message, /成功/);
  const rejected = createAttendance(async () => response({ ...loginResponse, msgCode: 401, success: true }));
  await assert.rejects(() => rejected.login(config), /登录状态已失效/);
});

test('查询只登录一次，携带 token 和动态员工 ID，明细和汇总按各自页码请求', async () => {
  const requests = [];
  const api = createAttendance(async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/login')) return response({ ...loginResponse, msgCode: 200 });
    const summary = String(url).includes('Summary');
    return response({ msgCode: 200, content: { totalCount: summary ? 51 : 22, body: summary
      ? [{ attendanceName: '年假', totalNum: '08:00', employeeId: { valueId: 42 } }]
      : [{ scheduleDate: '2026-10-01', employeeId: 42, timeAttendance: [] }] } });
  });
  const result = await api.report(config, { month: '2026-10', page: 2, pageSize: 20, summaryPage: 2 });
  assert.equal(requests.length, 3);
  for (const req of requests.slice(1)) {
    const url = new URL(req.url);
    assert.equal(req.options.method, 'GET');
    assert.equal(req.options.headers['X-Token'], 'test-token');
    assert.equal(url.searchParams.get('employeeId'), '42');
    assert.equal(url.searchParams.get('pageNum'), '2');
    assert.deepEqual(JSON.parse(url.searchParams.get('dateRange')), { beginDate: '2026-10-01', endDate: '2026-10-31' });
  }
  assert.equal(new URL(requests[1].url).searchParams.get('pageSize'), '20');
  assert.equal(new URL(requests[2].url).searchParams.get('pageSize'), '50');
  assert.equal(result.records.page, 2);
  assert.equal(result.summary.page, 2);
  assert.ok(!JSON.stringify(result).includes('test-token'));
  assert.ok(!JSON.stringify(result).includes(config.password));
});

test('单个查询失败时保留另一部分，业务鉴权失败不可误判为空列表', async () => {
  for (const failed of ['timeCardInfo', 'timeCardAttendanceSummary']) {
    const api = createAttendance(async url => {
      if (String(url).endsWith('/login')) return response(loginResponse);
      if (new URL(url).pathname.endsWith(failed)) return response({ msgCode: 403, msgText: 'sensitive-content', content: { body: [], totalCount: 0 } });
      return response({ msgCode: 200, content: { body: [], totalCount: 0 } });
    });
    const result = await api.report(config, { month: '2026-10' });
    const failedKey = failed === 'timeCardInfo' ? 'records' : 'summary';
    const successKey = failed === 'timeCardInfo' ? 'summary' : 'records';
    assert.equal(result[failedKey], null);
    assert.match(result[`${failedKey}Error`], /查询被拒绝/);
    assert.equal(result[successKey].total, 0);
    assert.ok(!JSON.stringify(result).includes('sensitive-content'));
  }
});

test('不兼容分页、两接口失败、员工数据不匹配和查询前无效参数均明确报错', async () => {
  for (const result of [
    { msgCode: 200, content: { body: {}, totalCount: 1 } },
    { msgCode: 200, content: { body: [], totalCount: -1 } },
    { msgCode: 200, content: { body: [], totalCount: 'NaN' } },
    { msgCode: 200, content: { body: Array(51).fill({ scheduleDate: '2026-10-01' }), totalCount: 51 } },
    { msgCode: 403 },
  ]) {
    const api = createAttendance(async url => response(String(url).endsWith('/login') ? loginResponse : result));
    await assert.rejects(() => api.report(config, { month: '2026-10' }));
  }
  const noNetwork = createAttendance(async () => { throw new Error('unexpected network'); });
  await assert.rejects(() => noNetwork.report(config, { month: '2026-13' }), /月份/);
});

test('年假与考勤查询、账号验证及真实打卡复用一次登录，年假按配置时区查询当前月', async () => {
  const requests = [];
  const api = createAttendance(async (url, options) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname.endsWith('/login')) return response(loginResponse);
    if (parsed.pathname.endsWith('/attendanceSummary')) return response({ msgCode: 200, content: { body: [{
      employeeId: 42, annualLeave: { baseNum: 80, initNum: 66, usedNum: 35.5, availableNum: 30.5 },
    }] } });
    return response({ msgCode: 200, content: { body: [], totalCount: 0 } });
  }, 12000, { clock: () => Date.parse('2026-12-31T17:00:00Z') });
  const quota = await api.quota(config);
  await api.report(config, { month: '2026-10' });
  await api.testLogin(config);
  await api.punch(config, false);
  assert.equal(requests.filter(req => req.parsed.pathname.endsWith('/login')).length, 1);
  const request = requests.find(req => req.parsed.pathname.endsWith('/attendanceSummary'));
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers['X-Token'], 'test-token');
  assert.equal(request.parsed.searchParams.get('employeeId'), '42');
  assert.equal(request.parsed.searchParams.get('skipAuth'), 'true');
  assert.deepEqual(JSON.parse(request.parsed.searchParams.get('filter')), {
    fieldName: 'employeeCode', condition: '=', fieldValue: 42, entityName: 'employee',
  });
  assert.deepEqual(JSON.parse(request.parsed.searchParams.get('dateRange')), { beginDate: '2027-01-01', endDate: '2027-01-31' });
  assert.equal(quota.current.year, 2027);
  assert.equal(quota.current.remaining, 30.5);
  assert.ok(!JSON.stringify(quota).includes('test-token'));
});

test('两条并发查询都遇到 HTTP401 或业务401 时只刷新一次，共用新 token', async () => {
  for (const rejection of [
    () => new Response('{}', { status: 401 }),
    () => response({ msgCode: 401 }),
    () => response({ success: false, message: 'Token expired' }),
  ]) {
    let logins = 0, queries = 0;
    const api = createAttendance(async (url, options) => {
      if (String(url).endsWith('/login')) {
        logins++;
        return response({ content: { body: { ...loginResponse.content.body, token: `token-${logins}` } } });
      }
      queries++;
      if (options.headers['X-Token'] === 'token-1') return rejection();
      assert.equal(options.headers['X-Token'], 'token-2');
      return response({ msgCode: 200, content: { body: [], totalCount: 0 } });
    });
    const result = await api.report(config, { month: '2026-10' });
    assert.equal(result.records.total, 0);
    assert.equal(result.summary.total, 0);
    assert.equal(logins, 2);
    assert.equal(queries, 4);
    await api.report(config, { month: '2026-10' });
    assert.equal(logins, 2);
  }
});

test('刷新后仍失效最多重试一次；权限不足不会重复登录', async () => {
  for (const [reply, expectedLogins, expectedQueries] of [
    [{ msgCode: 401 }, 2, 2], [{ msgCode: 403, msgText: '没有权限' }, 1, 1],
  ]) {
    let logins = 0, queries = 0;
    const api = createAttendance(async url => {
      if (String(url).endsWith('/login')) {
        logins++;
        return response({ content: { body: { ...loginResponse.content.body, token: `token-${logins}` } } });
      }
      queries++;
      return response(reply);
    });
    await assert.rejects(() => api.quota(config));
    assert.equal(logins, expectedLogins);
    assert.equal(queries, expectedQueries);
  }
});

test('打卡只在明确登录失效后刷新重试，超时、HTTP500、不明响应均不重放', async () => {
  for (const mode of ['expired', 'timeout', 'server', 'unknown', 'forbidden']) {
    let logins = 0, punches = 0;
    const bodies = [];
    const api = createAttendance(async (url, options) => {
      if (String(url).endsWith('/login')) {
        logins++;
        return response({ content: { body: { ...loginResponse.content.body, token: `token-${logins}` } } });
      }
      punches++;
      bodies.push(options.body);
      if (mode === 'expired') return punches === 1 ? new Response('{}', { status: 401 }) : response({ msgCode: 200 });
      if (mode === 'timeout') throw new Error('secret-timeout');
      if (mode === 'server') return new Response('{}', { status: 500 });
      if (mode === 'forbidden') return new Response('{}', { status: 403 });
      return response({});
    });
    if (mode === 'expired') {
      await api.punch(config, false);
      assert.equal(logins, 2);
      assert.equal(punches, 2);
      assert.equal(bodies[0], bodies[1]);
    } else {
      await assert.rejects(() => api.punch(config, false), error => error.outcome === (mode === 'forbidden' ? 'failed' : 'unknown'));
      assert.equal(logins, 1);
      assert.equal(punches, 1);
    }
  }
});
