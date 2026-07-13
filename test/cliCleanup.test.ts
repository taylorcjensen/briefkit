import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupTemporaryPublishOutput } from '../src/lib/cli.ts';
import { makeTempDir } from './helpers/process.ts';

test('temporary publish output cleanup is best-effort', async () => {
  const tempDir = await makeTempDir('cleanup-helper');
  const filePath = path.join(tempDir, 'file.txt');
  await fs.writeFile(filePath, 'temporary output', 'utf8');

  await assert.doesNotReject(cleanupTemporaryPublishOutput(tempDir));
  await assert.rejects(fs.access(tempDir));
  await assert.doesNotReject(cleanupTemporaryPublishOutput(tempDir));
});
