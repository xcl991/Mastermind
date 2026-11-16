import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'public', 'scripts', 'checks', 'tests']) {
  for (const name of await fs.readdir(directory)) {
    if (!/\.(?:mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
console.log('All JavaScript syntax checks passed.');
