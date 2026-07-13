import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build, dev } from 'astro';
import { loadReport } from './report.js';
import { assertCanPrepareOutputDirectory, isOutputOwnershipMarker, writeOutputOwnershipMarker } from './outputPolicy.js';
import { createWorkspace, syncWorkspace, type WorkspaceOptions } from './workspace.js';
import type { ColorMode } from './types.js';

interface ParsedArgs {
  command?: string;
  reportDir: string;
  port?: number;
  open: boolean;
  outDir?: string;
  colorMode: ColorMode;
  target?: string;
  apiKey?: string;
  duration?: string;
  indexed?: boolean;
  brief?: string;
}

interface PublishConfig {
  target?: string;
  apiKey?: string;
}

interface PublishFile {
  path: string;
  contentBase64: string;
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv.slice(2));

  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (args.command === 'publish-config') {
    await savePublishConfig(args);
    return;
  }

  if (args.command === 'unpublish') {
    await unpublishBriefFromArgs(args);
    return;
  }

  if (args.command !== 'dev' && args.command !== 'build' && args.command !== 'publish') {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const report = await loadReport(args.reportDir);
  const publishConfig = args.command === 'publish' ? await loadPublishConfig() : undefined;
  const publishTarget = args.command === 'publish' ? normalizeTarget(args.target ?? publishConfig?.target) : undefined;
  const publishApiKey = args.command === 'publish' ? args.apiKey ?? publishConfig?.apiKey : undefined;
  if (args.command === 'publish' && !publishTarget) throw new Error('Publish target is required. Run: briefkit publish-config set --target https://briefs.example.com --api-key KEY');
  if (args.command === 'publish' && !publishApiKey) throw new Error('Publish API key is required. Run: briefkit publish-config set --target https://briefs.example.com --api-key KEY');
  const shouldCleanPublishOutDir = args.command === 'publish' && !args.outDir;
  const outDir = shouldCleanPublishOutDir ? await fs.mkdtemp(path.join(os.tmpdir(), 'briefkit-publish-')) : args.outDir;
  const workspaceOptions: WorkspaceOptions = {
    mode: args.command === 'dev' ? 'dev' : 'build',
    colorMode: args.colorMode,
    outDir,
    port: args.port,
    site: publishTarget,
  };

  try {
    const workspace = await createWorkspace(report, workspaceOptions);

    if (args.command === 'dev') {
      const server = await runInWorkspace(workspace.dir, () => dev({ root: workspace.dir, server: { host: 'localhost', port: args.port, open: false } }));
      attachDevWorkspaceSync(server, workspace.dir, report.reportDir, workspaceOptions);
      const address = server.address;
      const url = typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost';
      if (args.open) openBrowserWithoutFocus(url);
      console.log('Briefkit dev server running');
      console.log(`Report: ${report.reportDir}`);
      console.log(`URL: ${url}`);
      if (args.open) console.log('Opened browser window in background.');
      return;
    }

    await assertCanPrepareOutputDirectory(workspace.outDir, report.reportDir);
    await fs.rm(workspace.outDir, { recursive: true, force: true });
    await runInWorkspace(workspace.dir, () => build({ root: workspace.dir }));
    await ensurePublicFallback(report.reportDir, workspace.outDir);
    await writeOutputOwnershipMarker(workspace.outDir);

    if (args.command === 'publish') {
      const target = publishTarget!;
      const apiKey = publishApiKey!;
      const files = await collectPublishFiles(workspace.outDir);
      const result = await publishBrief({ target, apiKey, title: report.title, duration: args.duration, indexed: args.indexed, files });
      console.log('Briefkit publish complete');
      console.log(`Report: ${report.reportDir}`);
      console.log(`URL: ${result.url}`);
      if (result.expiresAt) console.log(`Expires: ${result.expiresAt}`);
      if (result.expiresAt === null) console.log('Expires: never');
      return;
    }

    console.log('Briefkit build complete');
    console.log(`Report: ${report.reportDir}`);
    console.log(`Output: ${workspace.outDir}`);
  } finally {
    if (shouldCleanPublishOutDir && outDir) await cleanupTemporaryPublishOutput(outDir);
  }
}

export async function cleanupTemporaryPublishOutput(outDir: string): Promise<void> {
  try {
    await fs.rm(outDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Briefkit warning: could not remove temporary publish output ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function attachDevWorkspaceSync(server: Awaited<ReturnType<typeof dev>>, workspaceDir: string, reportDir: string, options: WorkspaceOptions): void {
  server.watcher.add(reportDir);

  let debounceTimer: NodeJS.Timeout | undefined;
  let syncQueue = Promise.resolve();
  const scheduleSync = (eventName: string, changedPath: string) => {
    if (!isReportSourcePath(reportDir, changedPath, path.resolve(options.outDir ?? path.join(reportDir, 'brief')))) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncQueue = syncQueue.then(async () => {
        try {
          const nextReport = await loadReport(reportDir);
          await syncWorkspace(workspaceDir, nextReport, options);
        } catch (error) {
          console.warn(`Briefkit warning: keeping last good dev workspace after ${eventName} for ${path.relative(reportDir, changedPath) || changedPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }, 100);
  };

  server.watcher.on('all', scheduleSync);
}

function isReportSourcePath(reportDir: string, changedPath: string, outDir: string): boolean {
  const resolvedChangedPath = path.resolve(changedPath);
  const relativePath = path.relative(reportDir, resolvedChangedPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;
  const relativeOutPath = path.relative(outDir, resolvedChangedPath);
  if (!relativeOutPath || (!relativeOutPath.startsWith('..') && !path.isAbsolute(relativeOutPath))) return false;
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => part === 'node_modules' || part === '.git')) return false;
  return true;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: args[0],
    reportDir: '.',
    open: true,
    colorMode: 'auto',
  };

  let index = 1;
  if (parsed.command === 'publish-config' && args[index] === 'set') index += 1;
  if (parsed.command === 'unpublish') {
    parsed.brief = requiredOptionValue(args[index], 'brief');
    index += 1;
  } else if (args[index] && !args[index].startsWith('-')) {
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
      parsed.outDir = path.resolve(requiredOptionValue(args[index + 1], '--out'));
      index += 2;
      continue;
    }
    if (arg === '--color-mode') {
      parsed.colorMode = parseColorMode(args[index + 1]);
      index += 2;
      continue;
    }
    if (arg === '--target') {
      parsed.target = requiredOptionValue(args[index + 1], '--target');
      index += 2;
      continue;
    }
    if (arg === '--api-key') {
      parsed.apiKey = requiredOptionValue(args[index + 1], '--api-key');
      index += 2;
      continue;
    }
    if (arg === '--duration') {
      parsed.duration = parseDuration(requiredOptionValue(args[index + 1], '--duration'));
      index += 2;
      continue;
    }
    if (arg === '--indexed') {
      parsed.indexed = true;
      index += 1;
      continue;
    }
    if (arg === '--no-indexed') {
      parsed.indexed = false;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function requiredOptionValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function parseColorMode(value: string | undefined): ColorMode {
  if (value === 'auto' || value === 'light' || value === 'dark') return value;
  throw new Error('--color-mode must be auto, light, or dark.');
}

function parseDuration(value: string): string {
  if (value === 'forever' || /^(\d+)(d|w|mo|y)$/.test(value)) return value;
  throw new Error('--duration must be forever or a value like 90d, 3mo, or 1y.');
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

async function savePublishConfig(args: ParsedArgs): Promise<void> {
  if (!args.target || !args.apiKey) throw new Error('Usage: briefkit publish-config set --target https://briefs.example.com --api-key KEY');
  const configPath = publishConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify({ target: normalizeTarget(args.target), apiKey: args.apiKey }, null, 2), { mode: 0o600 });
  console.log(`Briefkit publish config saved: ${configPath}`);
}

async function loadPublishConfig(): Promise<PublishConfig> {
  try {
    return JSON.parse(await fs.readFile(publishConfigPath(), 'utf8')) as PublishConfig;
  } catch {
    return {};
  }
}

function publishConfigPath(): string {
  return path.join(os.homedir(), '.config', 'briefkit', 'publish.json');
}

function normalizeTarget(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, '');
}

async function collectPublishFiles(rootDir: string): Promise<PublishFile[]> {
  const files: PublishFile[] = [];
  await collectPublishFilesFromDir(rootDir, rootDir, files);
  return files;
}

async function collectPublishFilesFromDir(rootDir: string, currentDir: string, files: PublishFile[]): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectPublishFilesFromDir(rootDir, sourcePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativeFilePath = path.relative(rootDir, sourcePath);
    if (isOutputOwnershipMarker(relativeFilePath)) continue;
    files.push({
      path: relativeFilePath.split(path.sep).join('/'),
      contentBase64: (await fs.readFile(sourcePath)).toString('base64'),
    });
  }
}

async function unpublishBriefFromArgs(args: ParsedArgs): Promise<void> {
  const publishConfig = await loadPublishConfig();
  const target = normalizeTarget(args.target ?? publishConfig.target);
  const apiKey = args.apiKey ?? publishConfig.apiKey;
  if (!target) throw new Error('Publish target is required. Run: briefkit publish-config set --target https://briefs.example.com --api-key KEY');
  if (!apiKey) throw new Error('Publish API key is required. Run: briefkit publish-config set --target https://briefs.example.com --api-key KEY');
  if (!args.brief) throw new Error('Usage: briefkit unpublish <url-or-slug>');
  const slug = slugFromBriefReference(args.brief);
  const result = await unpublishBrief({ target, apiKey, slug });
  console.log('Briefkit unpublish complete');
  console.log(`Deleted: ${result.slug}`);
}

function slugFromBriefReference(value: string): string {
  try {
    const url = new URL(value);
    const slug = url.pathname.split('/').filter(Boolean)[0];
    if (slug) return sanitizeSlug(slug);
  } catch {
    return sanitizeSlug(value);
  }
  throw new Error('Brief URL does not include an article slug.');
}

function sanitizeSlug(value: string): string {
  const slug = value.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error('Brief must be a URL or slug like article-title-slug.');
  return slug;
}

async function unpublishBrief(input: { target: string; apiKey: string; slug: string }): Promise<{ deleted: true; slug: string }> {
  const response = await fetch(`${input.target}/api/briefs/${encodeURIComponent(input.slug)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.apiKey}` },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; deleted?: boolean; slug?: string };
  if (!response.ok) throw new Error(payload.error ?? `Unpublish failed with HTTP ${response.status}`);
  if (payload.deleted !== true || !payload.slug) throw new Error('Publish server returned an invalid response.');
  return { deleted: true, slug: payload.slug };
}

async function publishBrief(input: { target: string; apiKey: string; title: string; duration?: string; indexed?: boolean; files: PublishFile[] }): Promise<{ url: string; slug: string; expiresAt: string | null }> {
  const response = await fetch(`${input.target}/api/publish`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: input.title, duration: input.duration, indexed: input.indexed, files: input.files }),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; url?: string; slug?: string; expiresAt?: string | null };
  if (!response.ok) throw new Error(payload.error ?? `Publish failed with HTTP ${response.status}`);
  if (!payload.url || !payload.slug || payload.expiresAt === undefined) throw new Error('Publish server returned an invalid response.');
  return { url: payload.url, slug: payload.slug, expiresAt: payload.expiresAt };
}

function printHelp(): void {
  console.log(`Briefkit

Usage:
  briefkit dev [report-dir] [--port 4311] [--no-open] [--color-mode auto|light|dark]
  briefkit build [report-dir] [--out ./brief] [--color-mode auto|light|dark]
  briefkit publish [report-dir] [--duration 90d|3mo|1y|forever] [--indexed|--no-indexed] [--target https://briefs.example.com] [--api-key KEY] [--color-mode auto|light|dark]
  briefkit unpublish <url-or-slug> [--target https://briefs.example.com] [--api-key KEY]
  briefkit publish-config set --target https://briefs.example.com --api-key KEY
`);
}
