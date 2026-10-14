import { resolve } from 'node:path';
import { createStore } from './store.js';
import { createAttendance } from './attendance.js';
import { createScheduler } from './scheduler.js';
import { createHttpServer } from './server.js';
import { hashPassword, validateAccount } from './security.js';

async function main() {
  const dataDir = resolve(process.env.DATA_DIR || 'data');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1～65535');
  if (process.env.APP_ORIGIN) {
    const url = new URL(process.env.APP_ORIGIN);
    if (url.origin !== process.env.APP_ORIGIN || !['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN 必须为不含路径的准确访问地址');
  }
  const store = createStore(dataDir, process.env.ENCRYPTION_KEY);
  if (!store.userCount() && (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD)) {
    const input = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, displayName: '管理员' };
    validateAccount(input);
    store.createUser(input, await hashPassword(input.password), 'admin', true);
  }
  const attendance = createAttendance(fetch, 12000, { store });
  const scheduler = createScheduler(store, attendance);
  const server = await createHttpServer({ store, scheduler, attendance });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST || '0.0.0.0', resolve);
  });
  scheduler.start();
  console.log(`FriendsShip 已启动：http://localhost:${port}，数据目录：${dataDir}`);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 30000);
    deadline.unref();
    const closed = new Promise(resolve => server.close(resolve));
    await scheduler.stop();
    await closed;
    store.close();
    clearTimeout(deadline);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch(error => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
