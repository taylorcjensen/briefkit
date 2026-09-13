import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireOutputLock } from './outputLock.js';
import type { ReportInfo } from './types.js';

export type BackupCommand = 'build' | 'publish';

interface UserConfig {
  backup?: {
    directory?: string;
  };
  [key: string]: unknown;
}

interface BackupManifest {
  owner: 'briefkit';
  version: 1;
  id: string;
  title: string;
  sourcePath: string;
  command: BackupCommand;
  updatedAt: string;
  sourceDirectory: 'source';
  siteDirectory: 'site';
}

interface BackupBriefInput {
  report: ReportInfo;
  builtSiteDir: string;
  backupDirectory: string;
  command: BackupCommand;
}

const BACKUP_MANIFEST = 'manifest.json';
const BACKUP_OWNER = 'briefkit';
const BACKUP_VERSION = 1;
const EXCLUDED_SOURCE_DIRECTORIES = new Set(['.git', 'node_modules']);

export async function loadBackupDirectory(): Promise<string | undefined> {
  const config = await readUserConfig();
  const configuredDirectory = config.backup?.directory;
  if (configuredDirectory === undefined) return undefined;
  if (typeof configuredDirectory !== 'string' || configuredDirectory.trim().length === 0) {
    throw new Error(`Briefkit backup.directory must be a non-empty string in ${userConfigPath()}.`);
  }
  return resolveUserPath(configuredDirectory);
}

export async function saveBackupDirectory(directory: string): Promise<string> {
  const resolvedDirectory = resolveUserPath(directory);
  const config = await readUserConfig();
  const nextConfig: UserConfig = {
    ...config,
    backup: {
      ...config.backup,
      directory: resolvedDirectory,
    },
  };
  const configPath = userConfigPath();
  const temporaryPath = `${configPath}.tmp-${process.pid}-${crypto.randomUUID()}`;

  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }

  return resolvedDirectory;
}

export async function backupBrief(input: BackupBriefInput): Promise<string> {
  const backupRoot = await canonicalBackupRoot(input.backupDirectory);
  const reportPath = await fs.realpath(input.report.reportDir);
  const builtSitePath = await fs.realpath(input.builtSiteDir);
  const id = backupId(input.report, reportPath);
  const backupPath = path.join(backupRoot, id);

  await rejectSymbolicLink(backupPath);
  assertPathsDoNotOverlap(backupPath, reportPath, 'report directory');
  assertPathsDoNotOverlap(backupPath, builtSitePath, 'build output directory');

  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireOutputLock(backupPath, input.command);
  const stagingPath = path.join(backupRoot, `.${id}.staging-${process.pid}-${crypto.randomUUID()}`);

  try {
    await assertBackupCanBeReplaced(backupPath, id);
    await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await copyReportSources(reportPath, builtSitePath, path.join(stagingPath, 'source'));
    await fs.cp(builtSitePath, path.join(stagingPath, 'site'), { recursive: true, preserveTimestamps: true });
    await writeManifest(stagingPath, {
      owner: BACKUP_OWNER,
      version: BACKUP_VERSION,
      id,
      title: input.report.title,
      sourcePath: reportPath,
      command: input.command,
      updatedAt: new Date().toISOString(),
      sourceDirectory: 'source',
      siteDirectory: 'site',
    });
    await replaceBackupDirectory(stagingPath, backupPath);
    return backupPath;
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true });
    await lock.release();
  }
}

export function backupId(report: ReportInfo, canonicalReportPath: string = path.resolve(report.reportDir)): string {
  const configuredId = report.config.backup?.id;
  if (configuredId !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(configuredId)) {
      throw new Error('Briefkit backup.id must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.');
    }
    return configuredId;
  }

  const directoryName = path.basename(canonicalReportPath);
  const slug = directoryName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64) || 'brief';
  const pathHash = crypto.createHash('sha256').update(canonicalReportPath).digest('hex').slice(0, 12);
  return `${slug}--${pathHash}`;
}

export function userConfigPath(): string {
  const configuredDirectory = process.env.BRIEFKIT_CONFIG_DIR;
  const configDirectory = configuredDirectory
    ? resolveUserPath(configuredDirectory)
    : path.join(os.homedir(), '.config', 'briefkit');
  return path.join(configDirectory, 'config.json');
}

async function readUserConfig(): Promise<UserConfig> {
  const configPath = userConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error(`Briefkit config is not valid JSON: ${configPath}. ${error.message}`);
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Briefkit config must contain a JSON object: ${configPath}.`);
  }
  const config = parsed as UserConfig;
  if (config.backup !== undefined && (!config.backup || typeof config.backup !== 'object' || Array.isArray(config.backup))) {
    throw new Error(`Briefkit backup config must contain a JSON object: ${configPath}.`);
  }
  return config;
}

function resolveUserPath(filePath: string): string {
  const trimmedPath = filePath.trim();
  if (trimmedPath === '~') return os.homedir();
  if (trimmedPath.startsWith('~/') || trimmedPath.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmedPath.slice(2));
  }
  return path.resolve(trimmedPath);
}

async function canonicalBackupRoot(backupDirectory: string): Promise<string> {
  return await canonicalPath(resolveUserPath(backupDirectory));
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parentPath = path.dirname(filePath);
    if (parentPath === filePath) return filePath;
    return path.join(await canonicalPath(parentPath), path.basename(filePath));
  }
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`Refusing to replace a symbolic link as a Briefkit backup: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertPathsDoNotOverlap(backupPath: string, otherPath: string, description: string): void {
  if (backupPath === otherPath || isAncestorPath(backupPath, otherPath) || isAncestorPath(otherPath, backupPath)) {
    throw new Error(`Refusing to place a Briefkit backup where it overlaps the ${description}: ${backupPath}`);
  }
}

function isAncestorPath(candidateAncestor: string, descendant: string): boolean {
  const relativePath = path.relative(candidateAncestor, descendant);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function assertBackupCanBeReplaced(backupPath: string, expectedId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0) return;

  try {
    const manifest = JSON.parse(await fs.readFile(path.join(backupPath, BACKUP_MANIFEST), 'utf8')) as Partial<BackupManifest>;
    if (manifest.owner === BACKUP_OWNER && manifest.version === BACKUP_VERSION && manifest.id === expectedId) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  throw new Error(`Refusing to replace non-empty backup directory without a matching Briefkit manifest: ${backupPath}`);
}

async function copyReportSources(reportDir: string, builtSiteDir: string, destination: string): Promise<void> {
  const resolvedReportDir = path.resolve(reportDir);
  const outputRelativePath = relativeDescendantPath(resolvedReportDir, builtSiteDir);

  await fs.cp(resolvedReportDir, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(resolvedReportDir, path.resolve(sourcePath));
      if (relativePath === '') return true;
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;
      if (EXCLUDED_SOURCE_DIRECTORIES.has(relativePath.split(path.sep)[0])) return false;
      if (outputRelativePath && (relativePath === outputRelativePath || isAncestorPath(outputRelativePath, relativePath))) return false;
      return true;
    },
  });
}

function relativeDescendantPath(parentPath: string, childPath: string): string | undefined {
  const relativePath = path.relative(parentPath, childPath);
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
  return relativePath;
}

async function writeManifest(stagingPath: string, manifest: BackupManifest): Promise<void> {
  await fs.writeFile(path.join(stagingPath, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function replaceBackupDirectory(stagingPath: string, backupPath: string): Promise<void> {
  const previousPath = `${backupPath}.previous-${process.pid}-${crypto.randomUUID()}`;
  const hadPreviousBackup = await pathExists(backupPath);

  if (hadPreviousBackup) await fs.rename(backupPath, previousPath);
  try {
    await fs.rename(stagingPath, backupPath);
  } catch (error) {
    if (hadPreviousBackup) await fs.rename(previousPath, backupPath);
    throw error;
  }
  if (hadPreviousBackup) await fs.rm(previousPath, { recursive: true, force: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
