#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (process.env.BRIEFKIT_TSX_RUN !== '1') {
  const result = spawnSync(process.execPath, ['--import', require.resolve('tsx/esm'), import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, BRIEFKIT_TSX_RUN: '1' },
  });
  process.exit(result.status ?? 1);
}

const { runCli } = await import('../src/lib/cli.ts');

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
