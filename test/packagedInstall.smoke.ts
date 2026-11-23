import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeBasicReport, makeTempDir } from './helpers/process.ts';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

test('packed npm prefix install can build a report from the installed CLI', { timeout: 120_000 }, async () => {
  const tempDir = await makeTempDir('packed-install');
  const packDir = path.join(tempDir, 'pack');
  const prefixDir = path.join(tempDir, 'prefix');
  const projectDir = path.join(tempDir, 'project');
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(prefixDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  const packedPackage = await packCurrentPackage(packDir);
  await runNpm(['install', '--global', '--prefix', prefixDir, '--prefer-offline', '--min-release-age=0', packedPackage], tempDir);

  const help = await runInstalledBriefkit(prefixDir, ['--help'], projectDir);
  assert.match(help.stdout, /briefkit build/);

  const reportDir = await makeBasicReport(projectDir);
  const outDir = path.join(projectDir, 'dist');
  const build = await runInstalledBriefkit(prefixDir, ['build', reportDir, '--out', outDir, '--color-mode', 'auto'], projectDir);
  assert.match(build.stdout, /Briefkit build complete/);

  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /Briefkit test content/);

  // The published CLI must resolve chart imports from its installed package, not this checkout.
  await fs.mkdir(path.join(reportDir, 'data'));
  await fs.writeFile(path.join(reportDir, 'data', 'revenue.csv'), 'month,revenue,private\nJan,12,SECRET-PACKAGED\n');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Packaged chart
---
\`\`\`recharts
import { BarChart, Bar } from 'recharts';
import rows from '@report/data/revenue.csv?pick=month,revenue';
export default function Chart() { return <BarChart width={300} height={200} data={rows}><Bar dataKey="revenue" /></BarChart>; }
\`\`\`
`);
  await fs.rm(path.join(reportDir, 'index.md'));
  const chartOut = path.join(projectDir, 'chart-dist');
  const chartBuild = await runInstalledBriefkit(prefixDir, ['build', reportDir, '--out', chartOut], projectDir);
  assert.match(chartBuild.stdout, /Briefkit build complete/);
  const chartHtml = await fs.readFile(path.join(chartOut, 'index.html'), 'utf8');
  assert.match(chartHtml, /<astro-island[^>]*client="only"/);
  const assets = path.join(chartOut, '_astro');
  const scripts = (await Promise.all((await fs.readdir(assets)).filter((entry) => entry.endsWith('.js')).map((entry) => fs.readFile(path.join(assets, entry), 'utf8')))).join('\n');
  assert.match(scripts, /Jan/);
  assert.doesNotMatch(scripts, /SECRET-PACKAGED|"private"/);
});

async function packCurrentPackage(packDir: string): Promise<string> {
  const { stdout } = await runNpm(['pack', '--pack-destination', packDir], packageRoot);
  const packageFileName = stdout.trim().split('\n').at(-1);
  assert.ok(packageFileName, 'npm pack should print the package tarball name');
  return path.join(packDir, packageFileName);
}

async function runInstalledBriefkit(prefixDir: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const packageRoot = await installedPackageRoot(prefixDir, cwd);
  return await runCommand(process.execPath, [path.join(packageRoot, 'bin', 'briefkit.js'), ...args], cwd);
}

async function installedPackageRoot(prefixDir: string, cwd: string): Promise<string> {
  const { stdout } = await runNpm(['root', '--global', '--prefix', prefixDir], cwd);
  return path.join(stdout.trim(), 'briefkit');
}

async function runNpm(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return await runCommand(process.execPath, [npmExecPath, ...args], cwd);
  return await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 1024 * 1024 * 20,
  });
}
