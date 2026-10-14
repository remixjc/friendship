import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { defaults, AppError, legacyHolidayUrl, localClock } from './config.js';
import { createVault } from './security.js';
import { credentialFingerprint } from './upstream-session.js';

export function createStore(dataDir, encryptionKey) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const vault = createVault(dataDir, encryptionKey);
  const path = join(dataDir, 'friends-ship.sqlite');
  const db = new DatabaseSync(path, { timeout: 5000 });
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
      disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config TEXT NOT NULL, password TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
      am TEXT NOT NULL, pm TEXT NOT NULL, workday INTEGER NOT NULL,
      source TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      refresh_workday INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,day)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL, slot TEXT NOT NULL, trigger TEXT NOT NULL,
      status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      employee_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unique_scheduled_run
      ON runs(user_id,day,slot) WHERE trigger='scheduled';
    CREATE INDEX IF NOT EXISTS runs_by_user ON runs(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      level TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS logs_by_user ON logs(user_id,id DESC);
    CREATE TABLE IF NOT EXISTS upstream_sessions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holiday_calendar (
      cache_key TEXT PRIMARY KEY, day TEXT NOT NULL,
      workday INTEGER NOT NULL CHECK(workday IN (0,1)), fetched_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(plans)').all().some(column => column.name === 'refresh_workday')) {
    db.exec('ALTER TABLE plans ADD COLUMN refresh_workday INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('PRAGMA user_version=3');
  // A submitted request may have reached the upstream before a process crash. Do not replay it.
  db.prepare("UPDATE runs SET status='unknown',message='服务在执行过程中重启；请核对考勤结果，系统不会自动重试',completed_at=? WHERE status='running'")
    .run(new Date().toISOString());
  const publicUser = row => row && ({
    id: row.id, username: row.username, displayName: row.display_name,
    role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at,
  });
  const store = {
    db, vault, publicUser,
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    userCount: () => db.prepare('SELECT count(*) AS n FROM users').get().n,
    getUser: id => db.prepare('SELECT * FROM users WHERE id=?').get(id),
    findUser: username => db.prepare('SELECT * FROM users WHERE username=?').get(username),
    users: () => db.prepare('SELECT * FROM users ORDER BY created_at').all(),
    createUser(input, hash, role = 'user', firstOnly = false) {
      return store.transaction(() => {
        if (firstOnly && store.userCount()) throw new AppError('系统已初始化', 409);
        if (store.findUser(input.username)) throw new AppError('用户名已存在', 409);
        const id = randomUUID();
        db.prepare('INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, input.username, input.displayName?.trim() || input.username, hash, role, new Date().toISOString());
        db.prepare('INSERT INTO settings(user_id,config,updated_at) VALUES(?,?,?)')
          .run(id, JSON.stringify(defaults), new Date().toISOString());
        return store.getUser(id);
      });
    },
    settings(id, secret = false) {
      const row = db.prepare('SELECT * FROM settings WHERE user_id=?').get(id);
      if (!row) throw new AppError('用户不存在', 404);
      const config = { ...structuredClone(defaults), ...JSON.parse(row.config) };
      return { ...config, hasPassword: Boolean(row.password), revision: row.revision, updatedAt: row.updated_at,
        ...(secret ? { password: vault.decrypt(row.password), userId: id } : {}) };
    },
    saveSettings(id, config, password, clearPassword = false) {
      const current = db.prepare('SELECT password,config FROM settings WHERE user_id=?').get(id);
      const encrypted = clearPassword ? '' : password ? vault.encrypt(password) : current.password;
      const previous = JSON.parse(current.config);
      const credentialsChanged = clearPassword || Boolean(password && password !== vault.decrypt(current.password)) || ['apiBaseUrl', 'company', 'username', 'source', 'openId']
        .some(key => previous[key] !== config[key]);
      store.transaction(() => {
        db.prepare('UPDATE settings SET config=?,password=?,revision=revision+1,updated_at=? WHERE user_id=?')
          .run(JSON.stringify(config), encrypted, new Date().toISOString(), id);
        if (credentialsChanged) db.prepare('DELETE FROM upstream_sessions WHERE user_id=?').run(id);
      });
    },
    loadUpstreamSession(id) {
      const row = db.prepare('SELECT payload FROM upstream_sessions WHERE user_id=?').get(id);
      if (!row) return null;
      try { return JSON.parse(vault.decrypt(row.payload)); }
      catch { db.prepare('DELETE FROM upstream_sessions WHERE user_id=?').run(id); return null; }
    },
    saveUpstreamSession(id, session) {
      const user = store.getUser(id);
      if (!user || user.disabled) return;
      if (credentialFingerprint(store.settings(id, true)) !== session.fingerprint) return;
      db.prepare(`INSERT INTO upstream_sessions(user_id,payload) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload`)
        .run(id, vault.encrypt(JSON.stringify(session)));
    },
    loadHoliday(key) {
      const row = db.prepare('SELECT day,workday,fetched_at FROM holiday_calendar WHERE cache_key=?').get(key);
      return row && { day: row.day, workday: Boolean(row.workday), fetchedAt: row.fetched_at };
    },
    saveHoliday(key, entry) {
      db.prepare(`INSERT INTO holiday_calendar(cache_key,day,workday,fetched_at) VALUES(?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET day=excluded.day,workday=excluded.workday,fetched_at=excluded.fetched_at`)
        .run(key, entry.day, Number(entry.workday), entry.fetchedAt);
    },
    plan: (id, day) => db.prepare('SELECT * FROM plans WHERE user_id=? AND day=?').get(id, day),
    log(id, level, event, message) {
      db.prepare('INSERT INTO logs(user_id,level,event,message,created_at) VALUES(?,?,?,?,?)')
        .run(id, level, event, message, new Date().toISOString());
    },
    runs(id, limit = 30, offset = 0) {
      return db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(id, limit, offset);
    },
    logs(id, limit = 100) {
      return db.prepare('SELECT * FROM logs WHERE user_id=? ORDER BY id DESC LIMIT ?').all(id, limit);
    },
    cleanup() {
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      db.prepare('DELETE FROM logs WHERE created_at<?').run(cutoff);
      db.prepare('DELETE FROM runs WHERE created_at<?').run(cutoff);
      db.prepare('DELETE FROM plans WHERE created_at<?').run(cutoff);
      db.prepare('DELETE FROM holiday_calendar WHERE fetched_at<?').run(Date.now() - 7 * 86400000);
    },
    close: () => db.close(),
  };
  store.transaction(() => {
    for (const row of db.prepare('SELECT user_id,config,revision FROM settings').all()) {
      const config = JSON.parse(row.config);
      if (config.holidayUrl !== legacyHolidayUrl) continue;
      config.holidayUrl = defaults.holidayUrl;
      const now = new Date();
      const { day } = localClock(now, config.timezone || defaults.timezone);
      db.prepare('UPDATE settings SET config=?,revision=revision+1,updated_at=? WHERE user_id=?')
        .run(JSON.stringify(config), now.toISOString(), row.user_id);
      // Recheck today's calendar while keeping the user's already chosen punch times.
      db.prepare('UPDATE plans SET revision=?,refresh_workday=1 WHERE user_id=? AND day=? AND revision=?')
        .run(row.revision + 1, row.user_id, day, row.revision);
      store.log(row.user_id, 'info', 'settings', '节假日接口已切换为提莫接口，保留原计划时间');
    }
  });
  return store;
}
