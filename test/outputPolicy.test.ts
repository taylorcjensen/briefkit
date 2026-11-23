import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { acquireOutputLock, outputLockPath } from '../src/lib/outputLock.ts';
import { assertCanPrepareOutputDirectory, OUTPUT_OWNERSHIP_MARKER, resolveSafeOutputPath, writeOutputOwnershipMarker } from '../src/lib/outputPolicy.ts';
import { makeBasicReport, makeTempDir, runBriefkit } from './helpers/process.ts';

test('build rejects a non-empty unmarked output directory and preserves its files', async () => {
  const tempDir = await makeTempDir('reject-unmarked');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const sentinelPath = path.join(outDir, 'sentinel.txt');
  await fs.mkdir(outDir);
  await fs.writeFile(sentinelPath, 'do not delete', 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir, '--color-mode', 'auto']);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Refusing to delete non-empty output directory without Briefkit ownership marker/);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'do not delete');
});

test('build can replace an output directory with a valid Briefkit marker', async () => {
  const tempDir = await makeTempDir('marked-rebuild');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const stalePath = path.join(outDir, 'stale.txt');
  await fs.mkdir(outDir);
  await fs.writeFile(stalePath, 'old content', 'utf8');
  await writeOutputOwnershipMarker(outDir);

  const result = await runBriefkit(['build', reportDir, '--out', outDir, '--color-mode', 'auto']);

  assert.equal(result.exitCode, 0, result.stderr);
  await assert.rejects(fs.access(stalePath));
  await fs.access(path.join(outDir, 'index.html'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outDir, OUTPUT_OWNERSHIP_MARKER), 'utf8')), {
    owner: 'briefkit',
    version: 1,
  });
  await assert.rejects(fs.access(outputLockPath(await resolveSafeOutputPath(outDir, reportDir))));
  assert.deepEqual(await buildWorkspacesForReport(reportDir), []);
});

test('output policy allows new and empty output directories', async () => {
  const tempDir = await makeTempDir('allow-empty');
  const reportDir = await makeBasicReport(tempDir);
  const newOutDir = path.join(tempDir, 'new-brief');
  const emptyOutDir = path.join(tempDir, 'empty-brief');
  await fs.mkdir(emptyOutDir);

  await assert.doesNotReject(assertCanPrepareOutputDirectory(newOutDir, reportDir));
  await assert.doesNotReject(assertCanPrepareOutputDirectory(emptyOutDir, reportDir));
});

test('output policy rejects dangerous canonical paths', async () => {
  const tempDir = await makeTempDir('reject-dangerous');
  const reportDir = await makeBasicReport(path.join(tempDir, 'nested'));

  await assert.rejects(assertCanPrepareOutputDirectory('/', reportDir), /filesystem root/);
  await assert.rejects(assertCanPrepareOutputDirectory(process.env.HOME ?? '', reportDir), /home directory/);
  await assert.rejects(assertCanPrepareOutputDirectory(process.cwd(), reportDir), /current working directory/);
  await assert.rejects(assertCanPrepareOutputDirectory(reportDir, reportDir), /report directory/);
  await assert.rejects(assertCanPrepareOutputDirectory(path.dirname(reportDir), reportDir), /ancestor of the report directory/);
});

test('output policy rejects symlinks that resolve to the report directory', async () => {
  const tempDir = await makeTempDir('reject-symlink');
  const reportDir = await makeBasicReport(tempDir);
  const outputSymlink = path.join(tempDir, 'report-link');
  await fs.symlink(reportDir, outputSymlink, 'dir');

  await assert.rejects(assertCanPrepareOutputDirectory(outputSymlink, reportDir), /report directory/);
});

test('concurrent same-report builds to distinct output directories both succeed', async () => {
  const tempDir = await makeTempDir('concurrent-distinct');
  const reportDir = await makeBasicReport(tempDir);
  const outA = path.join(tempDir, 'out-a');
  const outB = path.join(tempDir, 'out-b');

  const [resultA, resultB] = await Promise.all([
    runBriefkit(['build', reportDir, '--out', outA, '--color-mode', 'auto']),
    runBriefkit(['build', reportDir, '--out', outB, '--color-mode', 'auto']),
  ]);

  assert.equal(resultA.exitCode, 0, resultA.stderr);
  assert.equal(resultB.exitCode, 0, resultB.stderr);
  await fs.access(path.join(outA, 'index.html'));
  await fs.access(path.join(outB, 'index.html'));
});

test('held same-output lock makes build fail clearly without touching sentinel output', async () => {
  const tempDir = await makeTempDir('held-lock');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const sentinelPath = path.join(outDir, 'sentinel.txt');
  await fs.mkdir(outDir);
  await fs.writeFile(sentinelPath, 'do not delete', 'utf8');
  await writeOutputOwnershipMarker(outDir);
  const lock = await acquireOutputLock(await resolveSafeOutputPath(outDir, reportDir), 'build');

  try {
    const result = await runBriefkit(['build', reportDir, '--out', outDir, '--color-mode', 'auto']);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Briefkit output is locked by another build/);
    assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'do not delete');
  } finally {
    await lock.release();
  }
});

test('build failure releases output lock and cleans its generated workspace', async () => {
  const tempDir = await makeTempDir('build-failure-cleanup');
  const reportDir = await makeBasicReport(tempDir);
  await fs.writeFile(path.join(reportDir, 'index.md'), '# Broken\n\n<Broken', 'utf8');
  const outDir = path.join(tempDir, 'brief');

  const result = await runBriefkit(['build', reportDir, '--out', outDir, '--color-mode', 'auto']);

  assert.notEqual(result.exitCode, 0);
  await assert.rejects(fs.access(outputLockPath(await resolveSafeOutputPath(outDir, reportDir))));
  assert.deepEqual(await buildWorkspacesForReport(reportDir), []);
});

async function buildWorkspacesForReport(reportDir: string): Promise<string[]> {
  const crypto = await import('node:crypto');
  const os = await import('node:os');
  const slug = path.basename(reportDir).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'report';
  const hash = crypto.createHash('sha1').update(reportDir).digest('hex').slice(0, 8);
  const parentDir = path.join(os.tmpdir(), 'briefkit', 'workspaces', `${slug}-${hash}`);
  try {
    return (await fs.readdir(parentDir)).filter((entry) => entry.startsWith('build-'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('publish omits the local output ownership marker from uploaded files', async () => {
  const tempDir = await makeTempDir('publish-marker');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const capturedFiles: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/api/response-channels') {
        response.end(JSON.stringify({ id: 'test', submitUrl: '/submit', submitToken: 'submit', waitUrl: '/wait', waitToken: 'wait', expiresAt: null }));
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { files: Array<{ path: string }> };
      capturedFiles.push(...payload.files.map((file) => file.path));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: 'http://127.0.0.1/brief', slug: 'brief', expiresAt: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert(address);

  try {
    const result = await runBriefkit([
      'publish',
      reportDir,
      '--out',
      outDir,
      '--target',
      `http://127.0.0.1:${address.port}`,
      '--api-key',
      'test-key',
      '--no-indexed',
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert(capturedFiles.includes('index.html'));
    assert(!capturedFiles.includes(OUTPUT_OWNERSHIP_MARKER));
  } finally {
    server.close();
  }
});
