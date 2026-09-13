import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { makeBasicReport, makeTempDir, runBriefkit } from './helpers/process.ts';

async function configureBackup(configDir: string, backupDirectory: string): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), `${JSON.stringify({ backup: { directory: backupDirectory } }, null, 2)}\n`, 'utf8');
}

test('config set saves a global backup directory', async () => {
  const tempDir = await makeTempDir('backup-config');
  const configDir = path.join(tempDir, 'config');
  const backupDirectory = path.join(tempDir, 'backups');

  const result = await runBriefkit(['config', 'set', '--backup-dir', backupDirectory], {
    env: { BRIEFKIT_CONFIG_DIR: configDir },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Briefkit config saved/);
  assert.match(result.stdout, new RegExp(escapeRegExp(backupDirectory)));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')), {
    backup: { directory: backupDirectory },
  });
});

test('build backs up searchable sources and the built site, then replaces the previous snapshot', async () => {
  const tempDir = await makeTempDir('backup-build');
  const reportDir = await makeBasicReport(tempDir);
  const backupDirectory = path.join(tempDir, 'backups');
  const configDir = path.join(tempDir, 'config');

  await configureBackup(configDir, backupDirectory);
  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { title: 'Archived Report', backup: { id: 'stable-report' } };\n`, 'utf8');
  await fs.writeFile(path.join(reportDir, 'searchable.txt'), 'first snapshot', 'utf8');
  await fs.mkdir(path.join(reportDir, '.git'));
  await fs.writeFile(path.join(reportDir, '.git', 'ignored.txt'), 'ignore me', 'utf8');
  await fs.mkdir(path.join(reportDir, 'node_modules'));
  await fs.writeFile(path.join(reportDir, 'node_modules', 'ignored.txt'), 'ignore me', 'utf8');

  const firstBuild = await runBriefkit(['build', reportDir], {
    env: { BRIEFKIT_CONFIG_DIR: configDir },
  });

  assert.equal(firstBuild.exitCode, 0, firstBuild.stderr);
  const backupPath = path.join(await fs.realpath(backupDirectory), 'stable-report');
  assert.match(firstBuild.stdout, new RegExp(`Backup: ${escapeRegExp(backupPath)}`));
  assert.equal(await fs.readFile(path.join(backupPath, 'source', 'searchable.txt'), 'utf8'), 'first snapshot');
  await fs.access(path.join(backupPath, 'source', 'index.md'));
  await fs.access(path.join(backupPath, 'site', 'index.html'));
  await assert.rejects(fs.access(path.join(backupPath, 'source', '.git')));
  await assert.rejects(fs.access(path.join(backupPath, 'source', 'node_modules')));
  await assert.rejects(fs.access(path.join(backupPath, 'source', 'brief')));
  assert.deepEqual(await backupManifest(backupPath), {
    owner: 'briefkit',
    version: 1,
    id: 'stable-report',
    title: 'Archived Report',
    sourcePath: await fs.realpath(reportDir),
    command: 'build',
    sourceDirectory: 'source',
    siteDirectory: 'site',
  });

  await fs.rm(path.join(reportDir, 'searchable.txt'));
  await fs.writeFile(path.join(reportDir, 'index.md'), '# Test Report\n\nSecond snapshot.\n', 'utf8');

  const secondBuild = await runBriefkit(['build', reportDir], {
    env: { BRIEFKIT_CONFIG_DIR: configDir },
  });

  assert.equal(secondBuild.exitCode, 0, secondBuild.stderr);
  await assert.rejects(fs.access(path.join(backupPath, 'source', 'searchable.txt')));
  assert.match(await fs.readFile(path.join(backupPath, 'source', 'index.md'), 'utf8'), /Second snapshot/);
  assert.deepEqual((await fs.readdir(backupDirectory)).sort(), ['stable-report']);
});

test('publish creates a backup before uploading the built site', async () => {
  const tempDir = await makeTempDir('backup-publish');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'output');
  const backupDirectory = path.join(tempDir, 'backups');
  const configDir = path.join(tempDir, 'config');
  await configureBackup(configDir, backupDirectory);
  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { title: 'Published Report', backup: { id: 'published-report' } };\n`, 'utf8');

  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: 'http://127.0.0.1/published-report', slug: 'published-report', expiresAt: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

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
    ], { env: { BRIEFKIT_CONFIG_DIR: configDir } });

    assert.equal(result.exitCode, 0, result.stderr);
    const backupPath = path.join(await fs.realpath(backupDirectory), 'published-report');
    assert.match(result.stdout, new RegExp(`Backup: ${escapeRegExp(backupPath)}`));
    assert.equal((await backupManifest(backupPath)).command, 'publish');
    await fs.access(path.join(backupPath, 'source', 'index.md'));
    await fs.access(path.join(backupPath, 'site', 'index.html'));
  } finally {
    server.close();
  }
});

test('backup refuses to replace an unowned non-empty directory', async () => {
  const tempDir = await makeTempDir('backup-unowned');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'output');
  const backupDirectory = path.join(tempDir, 'backups');
  const backupPath = path.join(backupDirectory, 'protected');
  const sentinelPath = path.join(backupPath, 'sentinel.txt');
  const configDir = path.join(tempDir, 'config');
  await configureBackup(configDir, backupDirectory);
  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { backup: { id: 'protected' } };\n`, 'utf8');
  await fs.mkdir(backupPath, { recursive: true });
  await fs.writeFile(sentinelPath, 'keep me', 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir], {
    env: { BRIEFKIT_CONFIG_DIR: configDir },
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /without a matching Briefkit manifest/);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'keep me');
});

test('backup rejects a destination nested inside the report', async () => {
  const tempDir = await makeTempDir('backup-overlap');
  const reportDir = await makeBasicReport(tempDir);
  const outDir = path.join(tempDir, 'output');
  const configDir = path.join(tempDir, 'config');
  await configureBackup(configDir, path.join(reportDir, 'backups'));
  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { backup: { id: 'unsafe' } };\n`, 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir], {
    env: { BRIEFKIT_CONFIG_DIR: configDir },
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /overlaps the report directory/);
  await assert.rejects(fs.access(path.join(reportDir, 'backups')));
});

async function backupManifest(backupPath: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await fs.readFile(path.join(backupPath, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  delete manifest.updatedAt;
  return manifest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
