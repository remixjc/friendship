import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'public', 'scripts', 'test']) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', join(dir, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript 语法检查通过');
