import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build, dev } from 'astro';
import { loadReport } from './report.js';
import { createWorkspace } from './workspace.js';
import type { ColorMode } from './types.js';

interface ParsedArgs {
  command?: string;
  reportDir: string;
  port?: number;
  open: boolean;
  outDir?: string;
  colorMode: ColorMode;
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv.slice(2));

  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (args.command !== 'dev' && args.command !== 'build') {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const report = await loadReport(args.reportDir);
  const workspace = await createWorkspace(report, {
    mode: args.command,
    colorMode: args.colorMode,
    outDir: args.outDir,
    port: args.port,
  });

  if (args.command === 'dev') {
    const server = await runInWorkspace(workspace.dir, () => dev({ root: workspace.dir, server: { host: 'localhost', port: args.port, open: false } }));
    const address = server.address;
    const url = typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost';
    if (args.open) openBrowserWithoutFocus(url);
    console.log('Briefkit dev server running');
    console.log(`Report: ${report.reportDir}`);
    console.log(`URL: ${url}`);
    if (args.open) console.log('Opened browser window in background.');
    return;
  }

  await fs.rm(workspace.outDir, { recursive: true, force: true });
  await runInWorkspace(workspace.dir, () => build({ root: workspace.dir }));
  await ensurePublicFallback(report.reportDir, workspace.outDir);
  console.log('Briefkit build complete');
  console.log(`Report: ${report.reportDir}`);
  console.log(`Output: ${workspace.outDir}`);
}

async function runInWorkspace<T>(workspaceDir: string, action: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(workspaceDir);
  try {
    return await action();
  } finally {
    process.chdir(originalCwd);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: args[0],
    reportDir: '.',
    open: true,
    colorMode: 'auto',
  };

  let index = 1;
  if (args[index] && !args[index].startsWith('-')) {
    parsed.reportDir = args[index];
    index += 1;
  }

  while (index < args.length) {
    const arg = args[index];
    if (arg === '--no-open') {
      parsed.open = false;
      index += 1;
      continue;
    }
    if (arg === '--port') {
      parsed.port = Number(args[index + 1]);
      if (!Number.isInteger(parsed.port)) throw new Error('--port requires an integer.');
      index += 2;
      continue;
    }
    if (arg === '--out') {
      parsed.outDir = path.resolve(args[index + 1]);
      index += 2;
      continue;
    }
    if (arg === '--color-mode') {
      parsed.colorMode = parseColorMode(args[index + 1]);
      index += 2;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function parseColorMode(value: string | undefined): ColorMode {
  if (value === 'auto' || value === 'light' || value === 'dark') return value;
  throw new Error('--color-mode must be auto, light, or dark.');
}

function openBrowserWithoutFocus(url: string): void {
  if (process.platform === 'darwin') {
    spawn('open', ['-g', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const opener = process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensurePublicFallback(reportDir: string, outDir: string): Promise<void> {
  const publicDir = path.join(reportDir, 'public');
  try {
    await fs.access(publicDir);
  } catch {
    return;
  }
  await copyDir(publicDir, outDir);
}

async function copyDir(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

function printHelp(): void {
  console.log(`Briefkit

Usage:
  briefkit dev [report-dir] [--port 4311] [--no-open] [--color-mode auto|light|dark]
  briefkit build [report-dir] [--out ./brief] [--color-mode auto|light|dark]
`);
}
