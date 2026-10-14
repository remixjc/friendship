import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHolidayCalendar, HOLIDAY_CACHE_TTL, holidayRequestUrl, parseHoliday } from '../src/holidays.js';
import { createAttendance } from '../src/attendance.js';
import { createStore } from '../src/store.js';
import { defaults, legacyHolidayUrl, localClock } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';

const reply = type => ({ code: 0, type: { type } });
const day = '2026-10-14';

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
    store.db.exec('ALTER TABLE plans DROP COLUMN refresh_workday; DROP TABLE holiday_calendar; PRAGMA user_version=2');
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
