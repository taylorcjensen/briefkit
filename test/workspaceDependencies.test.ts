import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { cleanupWorkspace, createWorkspace } from '../src/lib/workspace.ts';
import type { ReportInfo } from '../src/lib/types.ts';
import { makeBasicReport, makeTempDir } from './helpers/process.ts';

const require = createRequire(import.meta.url);
const workspaceDependencies = ['astro', '@astrojs/mdx', '@astrojs/markdown-remark', 'yaml'] as const;

test('generated workspace links only the direct packages needed by Astro config', async (t) => {
  const tempDir = await makeTempDir('workspace-dependencies');
  const reportDir = await makeBasicReport(tempDir);
  const report = basicReport(reportDir);

  const workspace = await createWorkspace(report, { mode: 'build', colorMode: 'auto', outDir: path.join(tempDir, 'dist') });
  t.after(async () => cleanupWorkspace(workspace.dir));
  const nodeModulesPath = path.join(workspace.dir, 'node_modules');
  const nodeModulesStats = await fs.lstat(nodeModulesPath);
  assert.equal(nodeModulesStats.isSymbolicLink(), false);

  for (const packageName of workspaceDependencies) {
    const linkedPackagePath = path.join(nodeModulesPath, ...packageName.split('/'));
    const linkedPackageStats = await fs.lstat(linkedPackagePath);
    assert.equal(linkedPackageStats.isSymbolicLink() || linkedPackageStats.isDirectory(), true);
    assert.equal(await fs.realpath(linkedPackagePath), await fs.realpath(installedPackageRoot(packageName)));
  }
});

test('same report workspaces use distinct per-invocation directories', async () => {
  const tempDir = await makeTempDir('workspace-distinct');
  const reportDir = await makeBasicReport(tempDir);
  const report = basicReport(reportDir);

  const firstWorkspace = await createWorkspace(report, { mode: 'build', colorMode: 'auto', outDir: path.join(tempDir, 'dist-a') });
  const secondWorkspace = await createWorkspace(report, { mode: 'build', colorMode: 'auto', outDir: path.join(tempDir, 'dist-b') });
  try {
    assert.notEqual(firstWorkspace.dir, secondWorkspace.dir);
    await fs.access(path.join(firstWorkspace.dir, 'astro.config.mjs'));
    await fs.access(path.join(secondWorkspace.dir, 'astro.config.mjs'));
  } finally {
    await Promise.all([
      cleanupWorkspace(firstWorkspace.dir),
      cleanupWorkspace(secondWorkspace.dir),
    ]);
  }
});

function installedPackageRoot(packageName: string): string {
  let currentDir = path.dirname(require.resolve(packageName));
  while (currentDir !== path.dirname(currentDir)) {
    try {
      const manifest = require(path.join(currentDir, 'package.json')) as { name?: string };
      if (manifest.name === packageName) return currentDir;
    } catch {
      // Keep walking until the package manifest is found.
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(`Could not locate ${packageName}`);
}

function basicReport(reportDir: string): ReportInfo {
  return {
    reportDir,
    config: {},
    title: 'Test Report',
    pages: [
      {
        file: 'index.md',
        absolutePath: path.join(reportDir, 'index.md'),
        route: '/',
        title: 'Test Report',
        hidden: false,
        layout: 'report',
      },
    ],
  };
}
