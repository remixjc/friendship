import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { createAttendance } from '../src/attendance.js';
import { defaults } from '../src/config.js';

function fixture(t, punch) {
  const dir = mkdtempSync(join(tmpdir(), 'friends-ship-scheduler-'));
  const store = createStore(dir);
  const user = store.createUser({ username: 'tester' }, 'unused');
  const config = { ...defaults, enabled: true, amStart: '08:00', amEnd: '08:00', pmStart: '18:30', pmEnd: '18:30' };
  store.saveSettings(user.id, config);
  let now = new Date('2026-10-14T00:00:00Z');
  const api = createAttendance(async () => { throw new Error('Network must not be used'); });
  let calls = 0;
  api.punch = punch || (async () => { calls++; return { message: '模拟测试', employeeName: 'test' }; });
  const scheduler = createScheduler(store, api, () => now);
  t.after(async () => { await scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, user, scheduler, setNow: value => { now = new Date(value); }, calls: () => calls };
}

test('重复轮询及调度器重建后，同一计划仅提交一次', async t => {
  const f = fixture(t);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.store.runs(f.user.id).length, 1);
  const plan = f.store.plan(f.user.id, '2026-10-14');
  assert.equal(plan.am, '08:00');
  assert.equal(f.store.runs(f.user.id)[0].status, 'simulated');
  const restart = createScheduler(f.store, createAttendance(), () => new Date('2026-10-14T00:00:30Z'));
  await restart.tick();
  await restart.stop();
  assert.equal(f.store.runs(f.user.id).length, 1);
});

test('错过计划不补交，下午仍正常执行', async t => {
  const f = fixture(t);
  f.setNow('2026-10-14T00:02:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.store.runs(f.user.id)[0].status, 'skipped');
  f.setNow('2026-10-14T10:30:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.store.runs(f.user.id).length, 2);
});

test('全天休假暂停当天的任务，次日自动恢复', async t => {
  const f = fixture(t);
  f.store.saveLeave(f.user.id, '2026-10-14', { startTime: null, endTime: null });
  await assert.rejects(() => f.scheduler.manual(f.user.id, false), error => error.status === 409 && /处于休假/.test(error.message));
  await f.scheduler.tick();
  f.setNow('2026-10-14T10:30:00Z');
  await f.scheduler.tick();
  assert.deepEqual(f.store.runs(f.user.id).map(run => run.status), ['skipped', 'skipped']);
  assert.ok(f.store.runs(f.user.id).every(run => run.message.includes('休假时段')));
  assert.equal(f.calls(), 0);
  f.setNow('2026-10-15T00:00:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
});

test('跨月日期休假包含两端，重启后仍生效，结束后的第一个工作日恢复', async t => {
  const f = fixture(t);
  const range = f.store.saveLeaveRange(f.user.id, '', '2026-10-30', '2026-11-02');
  f.setNow('2026-10-30T00:00:00Z');
  await f.scheduler.tick();
  f.setNow('2026-11-02T00:00:00Z');
  const restarted = createScheduler(f.store, createAttendance(), () => new Date('2026-11-02T00:00:00Z'));
  t.after(() => restarted.stop());
  await assert.rejects(() => restarted.manual(f.user.id, false), error => error.status === 409);
  await restarted.tick();
  assert.deepEqual(f.store.runs(f.user.id).map(run => [run.day, run.status]), [
    ['2026-11-02', 'skipped'], ['2026-10-30', 'skipped'],
  ]);
  assert.ok(f.store.runs(f.user.id).every(run => run.message.includes('休假日期')));
  assert.equal(f.store.leaveRanges(f.user.id, '2026-11-02')[0].id, range.id);
  assert.equal(f.store.leaveRanges(f.user.id, '2026-11-03').length, 0);
  f.setNow('2026-11-03T00:00:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
});

test('时段休假覆盖计划分钟和实际轮询分钟，取消后仍不会补跑已跳过的任务', async t => {
  for (const [startTime, endTime] of [['07:30', '08:00'], ['08:01', '09:00']]) {
    const f = fixture(t);
    f.store.saveLeave(f.user.id, '2026-10-14', { startTime, endTime });
    f.setNow('2026-10-14T00:01:00Z');
    await f.scheduler.tick();
    assert.equal(f.calls(), 0);
    assert.equal(f.store.runs(f.user.id)[0].status, 'skipped');
    assert.match(f.store.runs(f.user.id)[0].message, /休假时段/);
    f.store.deleteLeave(f.user.id, '2026-10-14');
    await f.scheduler.tick();
    assert.equal(f.calls(), 0);
    f.setNow('2026-10-14T10:30:00Z');
    await f.scheduler.tick();
    assert.equal(f.calls(), 1);
  }
});

test('工作日覆盖和账户停用均阻止自动执行', async t => {
  const f = fixture(t);
  const config = f.store.settings(f.user.id);
  f.store.saveSettings(f.user.id, { ...config, workdayOverrides: { '2026-10-14': 0 } });
  await f.scheduler.tick();
  assert.equal(f.calls(), 0);
  f.store.saveSettings(f.user.id, { ...config, workdayOverrides: {} });
  f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.user.id);
  await f.scheduler.tick();
  assert.equal(f.calls(), 0);
});

test('修改配置重新生成计划，但不会重复已执行的定时任务', async t => {
  const f = fixture(t);
  await f.scheduler.tick();
  f.store.saveSettings(f.user.id, { ...f.store.settings(f.user.id), sites: ['新地点'] });
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.store.plan(f.user.id, '2026-10-14').revision, 3);
});

test('失败的定时任务不自动重试', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; throw new Error('secret-password'); });
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.runs(f.user.id)[0].status, 'failed');
  assert.ok(!f.store.runs(f.user.id)[0].message.includes('secret'));
});

test('同一用户运行期间拒绝另一任务，停止等待运行完成', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = () => resolve({ message: 'done', employeeName: 'test' }); }));
  const first = f.scheduler.manual(f.user.id, true);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => f.scheduler.manual(f.user.id, true), error => error.status === 409);
  const stopped = f.scheduler.stop();
  release();
  await first;
  await stopped;
  assert.equal(f.store.runs(f.user.id).length, 1);
});

test('服务重启把进行中记录标记为未知，不重放，密码和会话持续可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friends-ship-restart-'));
  let store = createStore(dir);
  try {
    const user = store.createUser({ username: 'tester' }, 'unused');
    store.saveSettings(user.id, defaults, 'test-sensitive-password');
    store.saveLeave(user.id, '2026-10-14', { startTime: '13:00', endTime: '20:00' });
    const range = store.saveLeaveRange(user.id, '', '2026-10-20', '2026-12-20');
    const row = store.db.prepare('SELECT password,config FROM settings WHERE user_id=?').get(user.id);
    assert.ok(!JSON.stringify(row).includes('test-sensitive-password'));
    store.db.prepare("INSERT INTO runs(id,user_id,day,slot,trigger,status,created_at) VALUES('r',?,'2026-10-14','am','scheduled','running',?)")
      .run(user.id, new Date().toISOString());
    store.close();
    store = createStore(dir);
    assert.equal(store.settings(user.id, true).password, 'test-sensitive-password');
    assert.equal(store.runs(user.id)[0].status, 'unknown');
    assert.deepEqual({ ...store.leave(user.id, '2026-10-14') }, { startTime: '13:00', endTime: '20:00' });
    assert.equal(store.overlappingLeave(user.id, '2026-11-14', '2026-11-14').id, range.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
