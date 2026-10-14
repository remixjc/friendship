import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store.js';
import { defaults } from '../src/config.js';
import { createUpstreamSessions } from '../src/upstream-session.js';

const config = { ...defaults, username: 'test-upstream', password: 'test-secret', openId: 'test-openid' };
const account = token => ({ token, employeeId: '42', openId: 'test-device', employeeName: '测试员工' });
const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
function memoryStore() {
  const entries = new Map();
  return { loadUpstreamSession: id => entries.get(id), saveUpstreamSession: (id, value) => entries.set(id, value) };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'friends-session-'));
  let store = createStore(dir);
  const user = store.createUser({ username: 'local-user' }, 'test-hash');
  store.saveSettings(user.id, { ...defaults, username: config.username, openId: config.openId }, config.password);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    id: user.id, get store() { return store; },
    reopen() { store.close(); store = createStore(dir); return store; },
  };
}

test('并发请求共享一次登录，过期拒绝共享一次刷新且接受已经刷新的 token', async () => {
  const sessions = createUpstreamSessions(memoryStore());
  let calls = 0;
  const login = async () => account(`token-${++calls}`);
  const first = await Promise.all(Array.from({ length: 10 }, () => sessions.get(config, login)));
  assert.ok(first.every(value => value.token === 'token-1'));
  const refreshed = await Promise.all(Array.from({ length: 10 }, () => sessions.get(config, login, 'token-1')));
  assert.ok(refreshed.every(value => value.token === 'token-2'));
  assert.equal((await sessions.get(config, login, 'token-1')).token, 'token-2');
  assert.equal(calls, 2);
});

test('JWT 到期前复用，到期时重新登录，零过期时间也会失效', async () => {
  let now = 1000, calls = 0;
  const sessions = createUpstreamSessions(memoryStore(), () => now);
  const login = async () => account(jwt(++calls === 1 ? 2 : 4));
  await sessions.get(config, login);
  now = 1999;
  await sessions.get(config, login);
  assert.equal(calls, 1);
  now = 2000;
  await sessions.get(config, login);
  assert.equal(calls, 2);
  const zero = createUpstreamSessions(memoryStore(), () => 0);
  let zeroCalls = 0;
  const expired = async () => { zeroCalls++; return account(jwt(0)); };
  await zero.get(config, expired);
  await zero.get(config, expired);
  assert.equal(zeroCalls, 2);
});

test('登录失败不缓存，随后允许重试；不同用户的会话彼此隔离', async () => {
  const sessions = createUpstreamSessions(memoryStore());
  await assert.rejects(() => sessions.get(config, async () => { throw new Error('login rejected'); }));
  let calls = 0;
  const login = async () => account(`token-${++calls}`);
  assert.equal((await sessions.get({ ...config, userId: 'a' }, login)).token, 'token-1');
  assert.equal((await sessions.get({ ...config, userId: 'b' }, login)).token, 'token-2');
  assert.equal((await sessions.get({ ...config, userId: 'a' }, login)).token, 'token-1');
});

test('token 加密持久化，关闭数据库重开后免登录复用，公开配置不泄露用户 ID 和 token', async t => {
  const f = fixture(t);
  let calls = 0;
  const login = async () => { calls++; return account('secret-persistent-token'); };
  await createUpstreamSessions(f.store).get(f.store.settings(f.id, true), login);
  const raw = f.store.db.prepare('SELECT payload FROM upstream_sessions').get().payload;
  assert.ok(!raw.includes('secret-persistent-token'));
  assert.ok(!raw.includes('test-device'));
  const reopened = f.reopen();
  assert.equal((await createUpstreamSessions(reopened).get(reopened.settings(f.id, true), login)).token, 'secret-persistent-token');
  assert.equal(calls, 1);
  const publicConfig = reopened.settings(f.id);
  assert.equal(publicConfig.userId, undefined);
  assert.ok(!JSON.stringify(publicConfig).includes('secret-persistent-token'));
});

test('修改日程或重填相同密码保留 token；修改凭据和清除密码撤销缓存', async t => {
  const f = fixture(t);
  const sessions = createUpstreamSessions(f.store);
  let calls = 0;
  const login = async () => account(`token-${++calls}`);
  await sessions.get(f.store.settings(f.id, true), login);
  f.store.saveSettings(f.id, { ...f.store.settings(f.id), amStart: '07:30' }, config.password);
  await sessions.get(f.store.settings(f.id, true), login);
  assert.equal(calls, 1);
  for (const field of ['company', 'username', 'openId', 'apiBaseUrl', 'source']) {
    const next = f.store.settings(f.id);
    next[field] = field === 'source' ? 6 : `${next[field]}-changed`;
    f.store.saveSettings(f.id, next);
    assert.equal(f.store.loadUpstreamSession(f.id), null);
    await sessions.get(f.store.settings(f.id, true), login);
  }
  f.store.saveSettings(f.id, f.store.settings(f.id), 'changed-password');
  assert.equal(f.store.loadUpstreamSession(f.id), null);
  await sessions.get(f.store.settings(f.id, true), login);
  f.store.saveSettings(f.id, f.store.settings(f.id), '', true);
  assert.equal(f.store.loadUpstreamSession(f.id), null);
});

test('等待中的旧登录不能在凭据修改或账户停用后重新写入缓存', async t => {
  const f = fixture(t);
  for (const action of ['credentials', 'disabled']) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const sessions = createUpstreamSessions(f.store);
    const pending = sessions.get(f.store.settings(f.id, true), () => new Promise(resolve => {
      release = resolve; started();
    }));
    await ready;
    if (action === 'credentials') f.store.saveSettings(f.id, { ...f.store.settings(f.id), username: 'changed-account' });
    else f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.id);
    release(account('stale-token'));
    await pending;
    assert.equal(f.store.loadUpstreamSession(f.id), null);
  }
});

test('损坏的加密会话会丢弃并重新登录', async t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO upstream_sessions(user_id,payload) VALUES(?,?)').run(f.id, 'corrupt');
  assert.equal(f.store.loadUpstreamSession(f.id), null);
  const result = await createUpstreamSessions(f.store).get(f.store.settings(f.id, true), async () => account('recovered-token'));
  assert.equal(result.token, 'recovered-token');
});
