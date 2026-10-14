import { randomUUID } from 'node:crypto';
import { AppError, localClock, minutes, randomTime } from './config.js';

export function createScheduler(store, attendance, clock = () => new Date()) {
  const locks = new Map();
  let timer;
  let ticking = false;
  let stopping = false;
  let lastCleanup = 0;
  const scheduler = {
    async withUser(id, fn) {
      if (stopping) throw new AppError('服务正在停止', 503);
      if (locks.has(id)) throw new AppError('该用户有任务正在执行，请稍后再试', 409);
      const promise = Promise.resolve().then(fn);
      locks.set(id, promise);
      try { return await promise; }
      finally { locks.delete(id); }
    },
    async ensurePlan(id, config = store.settings(id), now = clock()) {
      const { day, time } = localClock(now, config.timezone);
      let plan = store.plan(id, day);
      if (plan && plan.revision === config.revision) return plan;
      if (time < config.freshDate) return null;
      const work = await attendance.workday(config, day);
      plan = {
        user_id: id, day, am: randomTime(config.amStart, config.amEnd),
        pm: randomTime(config.pmStart, config.pmEnd), workday: Number(work.workday),
        source: work.source, revision: config.revision, created_at: now.toISOString(),
      };
      store.db.prepare(`INSERT INTO plans(user_id,day,am,pm,workday,source,revision,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET
        am=excluded.am,pm=excluded.pm,workday=excluded.workday,source=excluded.source,
        revision=excluded.revision,created_at=excluded.created_at`)
        .run(id, day, plan.am, plan.pm, plan.workday, plan.source, plan.revision, plan.created_at);
      store.log(id, work.warning ? 'warn' : 'info', 'plan', `${day}：${plan.am} / ${plan.pm}；${work.source}；${work.workday ? '工作日' : '休息日'}`);
      return plan;
    },
    async execute(id, config, { day, slot, trigger, dryRun }) {
      const runId = randomUUID();
      const now = clock().toISOString();
      const inserted = store.db.prepare(`INSERT OR IGNORE INTO runs(id,user_id,day,slot,trigger,status,created_at)
        VALUES(?,?,?,?,?,'running',?)`).run(runId, id, day, slot, trigger, now);
      if (!inserted.changes) return null;
      store.log(id, 'info', 'run', `${trigger === 'scheduled' ? '定时' : '手动'}${dryRun ? '模拟' : '打卡'}开始`);
      let status, message, employeeName = '';
      try {
        const result = await attendance.punch({ ...config, password: store.settings(id, true).password, userId: id }, dryRun);
        status = dryRun ? 'simulated' : 'success';
        message = result.message;
        employeeName = result.employeeName;
      } catch (error) {
        status = error.outcome || 'failed';
        message = error instanceof AppError ? error.message : '任务执行失败，请检查配置';
      }
      store.db.prepare('UPDATE runs SET status=?,message=?,employee_name=?,completed_at=? WHERE id=?')
        .run(status, message, employeeName, clock().toISOString(), runId);
      store.log(id, ['success', 'simulated'].includes(status) ? 'info' : 'error', 'run', message);
      return store.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    },
    async manual(id, dryRun = true) {
      return scheduler.withUser(id, async () => {
        const config = store.settings(id);
        if (!dryRun && config.dryRun) throw new AppError('请先在配置中关闭模拟模式，再执行真实打卡');
        if (!dryRun && (!config.company || !config.username || !config.hasPassword || !config.openId)) {
          throw new AppError('请先完成考勤账号配置');
        }
        return scheduler.execute(id, config, {
          day: localClock(clock(), config.timezone).day, slot: 'manual', trigger: 'manual', dryRun,
        });
      });
    },
    async tick() {
      if (ticking || stopping) return;
      ticking = true;
      try {
        if (Date.now() - lastCleanup > 3600000) { store.cleanup(); lastCleanup = Date.now(); }
        const users = store.users().filter(user => !user.disabled);
        // Bound concurrent upstream requests; one slow account cannot block every other user.
        for (let index = 0; index < users.length; index += 4) {
          await Promise.all(users.slice(index, index + 4).map(async user => {
            if (locks.has(user.id) || stopping) return;
            try {
              await scheduler.withUser(user.id, async () => {
                const config = store.settings(user.id);
                const now = clock();
                const plan = await scheduler.ensurePlan(user.id, config, now);
                if (!config.enabled || !plan?.workday) return;
                const { time, day } = localClock(clock(), config.timezone);
                if (day !== plan.day) return;
                for (const slot of ['am', 'pm']) {
                  const diff = minutes(time) - minutes(plan[slot]);
                  if (diff < 0) continue;
                  const existing = store.db.prepare("SELECT id FROM runs WHERE user_id=? AND day=? AND slot=? AND trigger='scheduled'")
                    .get(user.id, day, slot);
                  if (existing) continue;
                  if (diff > 1) {
                    store.db.prepare(`INSERT OR IGNORE INTO runs(id,user_id,day,slot,trigger,status,message,created_at,completed_at)
                      VALUES(?,?,?,?,'scheduled','skipped',?,?,?)`)
                      .run(randomUUID(), user.id, day, slot, '错过计划时间，未补打卡', now.toISOString(), now.toISOString());
                    store.log(user.id, 'warn', 'missed', `${day} ${plan[slot]}：错过计划时间，未补打卡`);
                  } else {
                    await scheduler.execute(user.id, config, { day, slot, trigger: 'scheduled', dryRun: config.dryRun });
                  }
                }
              });
            } catch (error) {
              if (!stopping) store.log(user.id, 'error', 'scheduler', error instanceof AppError ? error.message : '计划处理失败，请检查配置');
            }
          }));
        }
      } finally { ticking = false; }
    },
    start() {
      if (timer) return;
      void scheduler.tick().catch(() => console.error('调度器启动失败'));
      timer = setInterval(() => void scheduler.tick().catch(() => console.error('调度器执行失败')), 15000);
      timer.unref();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      while (locks.size) await Promise.allSettled([...locks.values()]);
    },
    get busy() { return locks.size; },
  };
  return scheduler;
}
