import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..', '..');

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `briefkit-${prefix}-`));
}

export async function makeBasicReport(parentDir: string): Promise<string> {
  const reportDir = path.join(parentDir, 'report');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'index.md'), '# Test Report\n\nBriefkit test content.\n', 'utf8');
  return reportDir;
}

export async function runBriefkit(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx/esm', path.join(packageRoot, 'bin', 'briefkit.js'), ...args], {
      cwd: options.cwd ?? packageRoot,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
      maxBuffer: 1024 * 1024 * 10,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failedProcess = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failedProcess.code ?? 1,
      stdout: failedProcess.stdout ?? '',
      stderr: failedProcess.stderr ?? '',
    };
  }
}
