import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireOutputLock, outputLockPath, releaseOutputLock } from '../src/lib/outputLock.ts';
import { resolveSafeOutputPath } from '../src/lib/outputPolicy.ts';
import { makeBasicReport, makeTempDir } from './helpers/process.ts';

test('output lock path is a sibling of the canonical output', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-path'), 'nested', 'out');
  assert.equal(outputLockPath(canonicalOutputPath), `${canonicalOutputPath}.briefkit.lock`);
});

test('output lock can be acquired, released, and reacquired', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-basic'), 'out');
  const firstLock = await acquireOutputLock(canonicalOutputPath, 'build');
  await firstLock.release();

  const secondLock = await acquireOutputLock(canonicalOutputPath, 'publish');
  await secondLock.release();
});

test('output lock excludes a live same-host owner', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-live'), 'out');
  const lock = await acquireOutputLock(canonicalOutputPath, 'build');
  try {
    await assert.rejects(acquireOutputLock(canonicalOutputPath, 'publish'), /Briefkit output is locked by another build/);
  } finally {
    await lock.release();
  }
});

test('output lock release is token safe', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-token'), 'out');
  const lock = await acquireOutputLock(canonicalOutputPath, 'build');
  try {
    await releaseOutputLock(lock.path, 'not-the-owner-token');
    await assert.rejects(acquireOutputLock(canonicalOutputPath, 'build'), /Briefkit output is locked/);
  } finally {
    await lock.release();
  }

  const reacquired = await acquireOutputLock(canonicalOutputPath, 'build');
  await reacquired.release();
});

test('output lock recovers a dead same-host owner', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-dead'), 'out');
  const deadPid = await exitedChildPid();
  await writeLockMetadata(canonicalOutputPath, { pid: deadPid });

  const lock = await acquireOutputLock(canonicalOutputPath, 'build');
  await lock.release();
});

test('many stale recovery contenders produce at most one owner without stealing the live lock', async () => {
  const canonicalOutputPath = path.join(await makeTempDir('lock-many-stale'), 'out');
  const deadPid = await exitedChildPid();
  await writeLockMetadata(canonicalOutputPath, { pid: deadPid });

  const results = await Promise.allSettled(Array.from({ length: 20 }, () => acquireOutputLock(canonicalOutputPath, 'build')));
  const acquiredLocks = results
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireOutputLock>>> => result.status === 'fulfilled')
    .map((result) => result.value);

  assert.equal(acquiredLocks.length, 1, results.map((result) => result.status === 'rejected' ? String(result.reason) : 'fulfilled').join('\n'));
  await assert.rejects(acquireOutputLock(canonicalOutputPath, 'publish'), /Briefkit output is locked by another build/);
  await acquiredLocks[0].release();
  await assert.rejects(fs.access(outputLockPath(canonicalOutputPath)));
});

test('output lock treats invalid, empty, and foreign-host metadata conservatively', async () => {
  const tempDir = await makeTempDir('lock-invalid');
  const invalidPath = path.join(tempDir, 'invalid');
  await fs.mkdir(path.dirname(outputLockPath(invalidPath)), { recursive: true });
  await fs.writeFile(outputLockPath(invalidPath), '{not json', 'utf8');
  await assert.rejects(acquireOutputLock(invalidPath, 'build'), /Briefkit output lock is unreadable or invalid/);
  await fs.rm(outputLockPath(invalidPath), { force: true });

  const emptyPath = path.join(tempDir, 'empty');
  await fs.writeFile(outputLockPath(emptyPath), '', 'utf8');
  await assert.rejects(acquireOutputLock(emptyPath, 'build'), /Briefkit output lock is unreadable or invalid/);
  await fs.rm(outputLockPath(emptyPath), { force: true });

  const foreignPath = path.join(tempDir, 'foreign');
  await writeLockMetadata(foreignPath, { hostname: 'briefkit-foreign-host.example' });
  await assert.rejects(acquireOutputLock(foreignPath, 'build'), /Briefkit output is locked by another host/);
  await fs.rm(outputLockPath(foreignPath), { force: true });
});

test('canonical symlink aliases collide on the same output lock', async () => {
  const tempDir = await makeTempDir('lock-symlink');
  const reportDir = await makeBasicReport(tempDir);
  const realOutDir = path.join(tempDir, 'real-out');
  await fs.mkdir(realOutDir);
  const linkedOutDir = path.join(tempDir, 'linked-out');
  await fs.symlink(realOutDir, linkedOutDir, 'dir');
  const realCanonicalPath = await resolveSafeOutputPath(realOutDir, reportDir);
  const linkedCanonicalPath = await resolveSafeOutputPath(linkedOutDir, reportDir);

  assert.equal(linkedCanonicalPath, realCanonicalPath);
  const lock = await acquireOutputLock(realCanonicalPath, 'build');
  try {
    await assert.rejects(acquireOutputLock(linkedCanonicalPath, 'build'), /Briefkit output is locked/);
  } finally {
    await lock.release();
  }
});

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  assert(pid);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  return pid;
}

async function writeLockMetadata(canonicalOutputPath: string, overrides: Partial<{ pid: number; hostname: string }> = {}): Promise<void> {
  await fs.mkdir(path.dirname(outputLockPath(canonicalOutputPath)), { recursive: true });
  await fs.writeFile(outputLockPath(canonicalOutputPath), `${JSON.stringify({
    version: 1,
    token: 'test-token',
    pid: overrides.pid ?? process.pid,
    hostname: overrides.hostname ?? os.hostname(),
    purpose: 'build',
    canonicalOutputPath,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}
