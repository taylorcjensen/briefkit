import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { assertCanPrepareOutputDirectory, OUTPUT_OWNERSHIP_MARKER, writeOutputOwnershipMarker } from '../src/lib/outputPolicy.ts';
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

test('publish omits the local output ownership marker from uploaded files', async () => {
  const tempDir = await makeTempDir('publish-marker');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const capturedFiles: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
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
