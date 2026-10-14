import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, importLegacy, localClock, randomTime, validateSettings } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/security.js';

test('计划以配置的时区计算日期，而不依赖容器时区', () => {
  const now = new Date('2026-10-13T16:01:00Z');
  assert.deepEqual(localClock(now, 'Asia/Shanghai'), { day: '2026-10-14', time: '00:01' });
  assert.deepEqual(localClock(now, 'America/New_York'), { day: '2026-10-13', time: '12:01' });
});

test('随机分钟支持完整范围及固定分钟', () => {
  assert.equal(randomTime('08:00', '08:20', (a, b) => b - 1), '08:20');
  assert.equal(randomTime('08:00', '08:20', a => a), '08:00');
  assert.equal(randomTime('08:20', '08:20'), '08:20');
});

test('拒绝错误时间、越界坐标、非法日期及启用未配置的真实任务', () => {
  for (const input of [
    { amStart: '25:00' }, { amStart: '09:00' }, { amEnd: '19:00' }, { freshDate: '16:00' },
    { latitude: 90, coordinateJitter: 0.0001 }, { longitude: NaN }, { timezone: 'invalid' },
    { workdayOverrides: { '2026-02-30': 1 } }, { workdayOverrides: [] },
    { enabled: true, dryRun: false }, { sites: [] }, { apiBaseUrl: 'http://localhost' },
    { apiBaseUrl: 'https://example.com/api/' },
  ]) assert.throws(() => validateSettings(input));
  assert.equal(validateSettings({ enabled: true, dryRun: true }).enabled, true);
  const configured = { ...defaults, username: 'demo', openId: 'demo-id' };
  assert.equal(validateSettings({ enabled: true, dryRun: false }, configured, true).dryRun, false);
});

test('旧配置导入修复过晚刷新时间，并保持任务关闭、模拟开启', () => {
  const settings = importLegacy({
    times: { amStart: '08:00', amEnd: '08:20', pmStart: '18:30', pmEnd: '19:00', freshDate: '16:00' },
    userInfo: [{ data: { company: 'demo', username: 'demo', password: 'sample-only', source: 5, openId: 'demo-id' } }],
  });
  assert.equal(settings.freshDate, '00:05');
  assert.equal(settings.enabled, false);
  assert.equal(settings.dryRun, true);
  assert.equal(validateSettings(settings, defaults, true).workdayMode, 'holiday');
});

test('登录密码使用不同盐值，验证正确密码并拒绝错误密码', async () => {
  const password = 'this-is-a-test-password';
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(await verifyPassword(password, first));
  assert.equal(await verifyPassword('wrong-password', first), false);
});
