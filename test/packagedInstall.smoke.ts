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
