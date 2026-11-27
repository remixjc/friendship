import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHolidayCalendar, HOLIDAY_CACHE_TTL, holidayRequestUrl, parseAppleHolidayCalendar, parseHoliday } from '../src/holidays.js';
import { createAttendance } from '../src/attendance.js';
import { createStore } from '../src/store.js';
import { appleHolidayUrl, defaults, legacyHolidayUrl, localClock } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';

const reply = type => ({ code: 0, type: { type } });
const day = '2026-10-14';
const calendarConfig = { ...defaults, workdayMode: 'holiday' };
const holidayYear = year => ({
  year, papers: ['https://www.gov.cn/zhengce/sample.htm'],
  days: [
    ['01-01', '元旦'], ['02-15', '春节'], ['04-05', '清明节'], ['05-01', '劳动节'],
    ['06-19', '端午节'], ['09-25', '中秋节'], ['10-01', '国庆节'],
  ].map(([date, name]) => ({ date: `${year}-${date}`, name, isOffDay: true })),
});
const appleFeed = (...years) => [
  'BEGIN:VCALENDAR', ...years.flatMap(year => [
    ...holidayYear(year).days.map(({ date, name }) => [
      'BEGIN:VEVENT', `DTSTART;VALUE=DATE:${date.replaceAll('-', '')}`, `SUMMARY;LANGUAGE=zh_CN:${name}（休）`, 'END:VEVENT',
    ].join('\r\n')),
    `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${year}1001\r\nDTEND;VALUE=DATE:${year}1008\r\nSUMMARY:国庆节（休）\r\nEND:VEVENT`,
    `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${year}1010\r\nSUMMARY:国庆节（\r\n 班）\r\nEND:VEVENT`,
    `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${year}0910\r\nSUMMARY:教师节\r\nEND:VEVENT`,
  ]), 'END:VCALENDAR',
].join('\r\n');

test('默认提莫日期模板和旧日期查询参数分别构建请求，保留其他参数', () => {
  assert.equal(holidayRequestUrl(defaults.holidayUrl, day).href, 'https://timor.tech/api/holiday/info/2026-10-14');
  assert.equal(holidayRequestUrl(`${legacyHolidayUrl}?size=10`, day).searchParams.get('date'), '20261014');
  assert.equal(holidayRequestUrl(`${legacyHolidayUrl}?size=10`, day).searchParams.get('size'), '10');
  assert.throws(() => holidayRequestUrl(defaults.holidayUrl, '2026-02-30'), /日期无效/);
});

test('工作日与调休补班为工作，周末与法定假期休息；拒绝未知类型和错误日期', () => {
  assert.equal(parseHoliday(reply(0)), true);
  assert.equal(parseHoliday(reply(3)), true);
  assert.equal(parseHoliday(reply(1)), false);
  assert.equal(parseHoliday(reply(2)), false);
  assert.equal(parseHoliday({ code: 0, data: { list: [{ workday: '1' }] } }), true);
  assert.equal(parseHoliday({ data: { list: [{ workday: 0 }] } }), false);
  for (const invalid of [
    null, {}, { code: -1, type: { type: 0 } }, reply(4), reply('0'),
    { ...reply(0), success: false }, { code: 80006, data: { list: [{ workday: 1 }] } },
    { msgCode: 403, data: { list: [{ workday: 1 }] } },
    { ...reply(0), holiday: { date: '2026-10-01' } },
    { code: 0, type: { type: 0, week: 4 } },
  ]) assert.throws(() => parseHoliday(invalid, day));
});

test('Apple 日历按全天事件的开始和结束日期解析，只使用明确标记的放假与补班', () => {
  const { days, completeYears } = parseAppleHolidayCalendar(appleFeed(2026));
  assert.deepEqual(completeYears, [2026]);
  assert.equal(days['2026-10-07'], false);
  assert.equal(days['2026-10-08'], undefined);
  assert.equal(days['2026-10-10'], true);
  assert.equal(days['2026-09-10'], undefined);
  assert.throws(() => parseAppleHolidayCalendar(appleFeed(2026).replace('中秋节（休）', '中秋节')), /缺少完整年度/);
  assert.throws(() => parseAppleHolidayCalendar(appleFeed(2026).replace('20261010', '20260230')), /无效日期/);
});

test('主接口超时自动切换 Apple，设置 Apple 为主源时失败则切换提莫', async () => {
  const calls = [];
  const fetch = async (url, { signal, headers }) => {
    calls.push(url.hostname);
    if (url.hostname === 'calendars.icloud.com') {
      assert.equal(headers.Accept, 'text/calendar');
      return new Response(appleFeed(2026));
    }
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => resolve(new Response('{}')), 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    });
  };
  const api = createAttendance(fetch, 15);
  const result = await api.workday(calendarConfig, '2026-10-10');
  assert.deepEqual(result, { workday: true, source: 'Apple 节假日日历' });
  assert.deepEqual(calls, ['timor.tech', 'calendars.icloud.com']);
  calls.length = 0;
  const appleFirst = createAttendance(async url => {
    calls.push(url.hostname);
    return new Response(url.hostname === 'calendars.icloud.com' ? appleFeed(2025) : JSON.stringify(reply(2)));
  });
  assert.deepEqual(await appleFirst.workday({ ...calendarConfig, holidayUrl: appleHolidayUrl }, '2026-10-01'),
    { workday: false, source: '节假日接口' });
  assert.deepEqual(calls, ['calendars.icloud.com', 'timor.tech']);
});

test('Apple 按北京时间每天刷新一次，离线多天和重启后继续使用本地日历', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-apple-local-'));
  let store = createStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-01T15:58:00Z');
  let requests = 0;
  const download = async () => { requests++; return appleFeed(2026, 2027); };
  let calendar = createHolidayCalendar(store, () => now);
  const results = await Promise.all([
    calendar.getApple('2026-10-01', download),
    calendar.getApple('2026-10-10', download),
    calendar.getApple('2027-10-01', download),
  ]);
  assert.deepEqual(results.map(result => result.workday), [false, true, false]);
  assert.equal(requests, 1);
  now += 60000;
  await calendar.getApple('2026-10-02', download);
  assert.equal(requests, 1);
  now += 60000;
  await Promise.all([calendar.refreshApple(download), calendar.refreshApple(download)]);
  assert.equal(requests, 2);
  now += 30 * HOLIDAY_CACHE_TTL;
  store.db.prepare("UPDATE holiday_schedules SET fetched_at=? WHERE cache_key='apple'").run(1);
  store.cleanup();
  store.close();
  store = createStore(dir);
  calendar = createHolidayCalendar(store, () => now);
  let rejectDownload;
  const offline = () => {
    requests++;
    return new Promise((_, reject) => { rejectDownload = reject; });
  };
  assert.deepEqual(await calendar.getApple('2026-10-10', offline),
    { workday: true, source: 'Apple 节假日日历（本地）' });
  rejectDownload(new Error('offline'));
  await calendar.waitForAppleRefresh();
  store.close();
  store = createStore(dir);
  calendar = createHolidayCalendar(store, () => now);
  assert.deepEqual(await calendar.getApple('2027-10-01', download),
    { workday: false, source: 'Apple 节假日日历（本地）' });
  assert.equal(requests, 3);
  now += HOLIDAY_CACHE_TTL;
  await calendar.refreshApple(async () => appleFeed(2026));
  assert.equal(calendar.getLocalApple('2027-10-01').workday, false);
  assert.equal(calendar.getLocalApple('2028-10-01'), null);
});

test('早上判断失败后自动恢复 Apple 快照，保留下午计划且不补打上午', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-apple-recover-'));
  const store = createStore(dir);
  const user = store.createUser({ username: 'tester' }, 'unused');
  store.saveSettings(user.id, { ...calendarConfig, holidayUrl: appleHolidayUrl, enabled: true,
    amStart: '08:47', amEnd: '08:47', pmStart: '18:38', pmEnd: '18:38' });
  let now = Date.parse('2026-10-14T00:47:00Z');
  let online = false;
  let requests = 0;
  const api = createAttendance(async url => {
    requests++;
    if (online && url.href === appleHolidayUrl) return new Response(appleFeed(2026, 2027));
    throw new Error('offline');
  }, 12000, { store, clock: () => now });
  const scheduler = createScheduler(store, api, () => new Date(now));
  t.after(async () => {
    await scheduler.stop();
    await api.waitForAppleRefresh();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await scheduler.tick();
  assert.equal(store.plan(user.id, day).workday, 0);
  assert.equal(store.runs(user.id).length, 0);
  now = Date.parse('2026-10-14T05:00:00Z');
  online = true;
  await scheduler.tick();
  await api.waitForAppleRefresh();
  const fetched = requests;
  online = false;
  now = Date.parse('2026-10-14T10:38:00Z');
  await scheduler.tick();
  const plan = store.plan(user.id, day);
  assert.equal(plan.pm, '18:38');
  assert.equal(plan.workday, 1);
  assert.match(plan.source, /本地/);
  assert.equal(requests, fetched);
  const runs = Object.fromEntries(store.runs(user.id).map(run => [run.slot, run.status]));
  assert.deepEqual(runs, { am: 'skipped', pm: 'simulated' });
});

test('年度备用日历拒绝不完整的镜像，合并跨年安排并在重启后跨日期复用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-annual-calendar-'));
  let store = createStore(dir);
  const calls = [];
  const fetch = async url => {
    calls.push(url.href);
    if (!/[0-9]{4}\.json$/.test(url.pathname)) return new Response('', { status: 503 });
    const year = Number(url.pathname.slice(-9, -5));
    const data = holidayYear(year);
    if (url.hostname === 'cdn.jsdelivr.net') data.days = data.days.slice(0, 1);
    if (year === 2027) data.days.push({ date: '2026-12-31', name: '元旦', isOffDay: true });
    return Response.json(data);
  };
  try {
    const api = createAttendance(fetch, 12000, { store });
    const result = await api.workday(calendarConfig, '2026-12-31');
    assert.deepEqual(result, { workday: false, source: '节假日备用日历' });
    assert.equal(calls.filter(url => url.includes('cdn.jsdelivr.net')).length, 2);
    assert.equal(calls.filter(url => url.includes('raw.githubusercontent.com')).length, 2);
    store.close();
    store = createStore(dir);
    const restarted = createAttendance(fetch, 12000, { store });
    assert.deepEqual(await restarted.workday(calendarConfig, '2026-12-30'),
      { workday: true, source: '节假日备用日历（缓存）' });
    assert.equal(calls.filter(url => url.endsWith('.json')).length, 4);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('同日期并发查询合并，工作与休息结果都缓存，不同日期及接口相互隔离', async () => {
  const calendar = createHolidayCalendar();
  let requests = 0;
  const request = async () => { requests++; return reply(1); };
  const values = await Promise.all(Array.from({ length: 10 }, () => calendar.get(defaults.holidayUrl, day, request)));
  assert.ok(values.every(value => !value.workday));
  assert.equal(requests, 1);
  assert.equal((await calendar.get(defaults.holidayUrl, day, request)).source, '节假日接口（缓存）');
  await calendar.get(defaults.holidayUrl, '2026-10-15', request);
  await calendar.get('https://other.example/info/{date}', day, request);
  assert.equal(requests, 3);
});

test('失败不是休息日缓存，短暂冷却后重试，24 小时到期重新查询', async () => {
  let now = 100000, requests = 0;
  const calendar = createHolidayCalendar(undefined, () => now);
  const failed = async () => { requests++; throw new Error('offline'); };
  await assert.rejects(() => calendar.get(defaults.holidayUrl, day, failed));
  await assert.rejects(() => calendar.get(defaults.holidayUrl, day, failed));
  assert.equal(requests, 1);
  now += 60000;
  const success = async () => { requests++; return reply(0); };
  await calendar.get(defaults.holidayUrl, day, success);
  now += HOLIDAY_CACHE_TTL - 1;
  await calendar.get(defaults.holidayUrl, day, success);
  assert.equal(requests, 2);
  now++;
  await calendar.get(defaults.holidayUrl, day, success);
  assert.equal(requests, 3);
});

test('成功缓存持久化，重启和不同用户共享缓存，日期覆盖优先且不请求外网', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-calendar-'));
  let store = createStore(dir);
  let requests = 0;
  const fetch = async () => { requests++; return new Response(JSON.stringify(reply(3))); };
  try {
    const config = { ...defaults, workdayMode: 'holiday' };
    const first = createAttendance(fetch, 12000, { store });
    await first.workday({ ...config, userId: 'a' }, day);
    store.close();
    store = createStore(dir);
    const second = createAttendance(fetch, 12000, { store });
    const cached = await second.workday({ ...config, userId: 'b' }, day);
    assert.equal(cached.workday, true);
    assert.equal(cached.source, '节假日接口（缓存）');
    const override = await second.workday({ ...config, workdayOverrides: { [day]: 0 } }, day);
    assert.equal(override.workday, false);
    assert.equal(override.source, '日期覆盖');
    assert.equal(requests, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧接口配置自动迁移且保留密码、当天原计划时间、执行记录和自定义接口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-calendar-migrate-'));
  let store = createStore(dir);
  try {
    const user = store.createUser({ username: 'legacy' }, 'unused');
    const custom = store.createUser({ username: 'custom' }, 'unused');
    const today = localClock(new Date(), defaults.timezone).day;
    store.saveSettings(user.id, { ...defaults, workdayMode: 'holiday', holidayUrl: legacyHolidayUrl }, 'test-password');
    store.saveSettings(custom.id, { ...defaults, holidayUrl: 'https://custom.example/calendar' });
    const revision = store.settings(user.id).revision;
    store.db.prepare(`INSERT INTO plans(user_id,day,am,pm,workday,source,revision,created_at)
      VALUES(?,?,'08:17','18:42',0,'接口失败，跳过今日任务',?,?)`)
      .run(user.id, today, revision, new Date().toISOString());
    store.db.prepare(`INSERT INTO runs(id,user_id,day,slot,trigger,status,created_at)
      VALUES('past',?,?,'am','scheduled','success',?)`).run(user.id, today, new Date().toISOString());
    // Simulate the deployed v2 schema to exercise the additive migration.
    store.db.exec('ALTER TABLE plans DROP COLUMN refresh_workday; DROP TABLE holiday_calendar; DROP TABLE holiday_schedules; DROP TABLE daily_leave; PRAGMA user_version=2');
    store.close();
    store = createStore(dir);
    assert.equal(store.settings(user.id).holidayUrl, defaults.holidayUrl);
    assert.equal(store.settings(user.id, true).password, 'test-password');
    assert.equal(store.settings(custom.id).holidayUrl, 'https://custom.example/calendar');
    assert.equal(store.plan(user.id, today).refresh_workday, 1);
    assert.equal(store.runs(user.id)[0].status, 'success');
    const api = { workday: async () => ({ workday: true, source: '节假日接口' }) };
    const scheduler = createScheduler(store, api);
    const plan = await scheduler.ensurePlan(user.id, store.settings(user.id), new Date(`${today}T04:00:00Z`));
    assert.equal(plan.am, '08:17');
    assert.equal(plan.pm, '18:42');
    assert.equal(plan.workday, 1);
    assert.equal(store.plan(user.id, today).refresh_workday, 0);
    await scheduler.stop();
    const changedRevision = store.settings(user.id).revision;
    store.close();
    store = createStore(dir);
    assert.equal(store.settings(user.id).revision, changedRevision);
    assert.equal(store.plan(user.id, today).refresh_workday, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('接口失败跳过时日志不会误报休息日，回退策略仍由个人配置决定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-calendar-error-'));
  const store = createStore(dir);
  try {
    const user = store.createUser({ username: 'test' }, 'unused');
    store.saveSettings(user.id, { ...defaults, workdayMode: 'holiday', holidayFallback: 'skip' });
    const api = createAttendance(async () => { throw new Error('offline'); });
    const scheduler = createScheduler(store, api, () => new Date('2026-10-14T04:00:00Z'));
    const plan = await scheduler.ensurePlan(user.id);
    assert.equal(plan.workday, 0);
    assert.match(store.logs(user.id)[0].message, /工作日未确定，已跳过/);
    assert.ok(!store.logs(user.id)[0].message.includes('休息日'));
    assert.equal((await api.workday({ ...defaults, workdayMode: 'holiday', holidayFallback: 'weekdays' }, day)).workday, true);
    await scheduler.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
