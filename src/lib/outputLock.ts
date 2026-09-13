import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';

export type OutputLockPurpose = 'build' | 'publish';

export interface OutputLock {
  canonicalOutputPath: string;
  path: string;
  token: string;
  release: () => Promise<void>;
}

interface OutputLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  purpose: OutputLockPurpose;
  canonicalOutputPath: string;
  createdAt: string;
}

const LOCK_VERSION = 1;

export async function acquireOutputLock(canonicalOutputPath: string, purpose: OutputLockPurpose): Promise<OutputLock> {
  const lockPath = outputLockPath(canonicalOutputPath);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomUUID();
  const metadata = lockMetadata(token, purpose, canonicalOutputPath);

  for (;;) {
    const claimResult = await tryClaimLockFile(lockPath, metadata);
    if (claimResult === 'claimed') {
      return {
        canonicalOutputPath,
        path: lockPath,
        token,
        release: () => releaseOutputLock(lockPath, token),
      };
    }
    await recoverOrRejectExistingLock(lockPath, canonicalOutputPath);
  }
}

export async function releaseOutputLock(lockPath: string, token: string): Promise<void> {
  const releasePath = `${lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.link(lockPath, releasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw lockError(`Briefkit could not inspect output lock for release: ${lockPath}. ${errorMessage(error)}`);
  }

  try {
    const metadata = await readLockMetadata(releasePath);
    if (metadata.token !== token || !(await pathsShareInode(lockPath, releasePath))) return;
    await fs.unlink(lockPath);
  } finally {
    await fs.rm(releasePath, { force: true });
  }
}

export function outputLockPath(canonicalOutputPath: string): string {
  return `${canonicalOutputPath}.briefkit.lock`;
}

async function tryClaimLockFile(lockPath: string, metadata: OutputLockMetadata): Promise<'claimed' | 'already-locked'> {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(candidatePath, lockFileContent(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.link(candidatePath, lockPath);
    return 'claimed';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'already-locked';
    throw atomicLinkError(lockPath, error);
  } finally {
    await fs.rm(candidatePath, { force: true });
  }
}

function lockFileContent(metadata: OutputLockMetadata): string {
  return `${JSON.stringify({ version: LOCK_VERSION, ...metadata }, null, 2)}\n`;
}

function lockMetadata(token: string, purpose: OutputLockPurpose, canonicalOutputPath: string): OutputLockMetadata {
  return {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    purpose,
    canonicalOutputPath,
    createdAt: new Date().toISOString(),
  };
}

async function recoverOrRejectExistingLock(lockPath: string, requestedCanonicalOutputPath: string): Promise<void> {
  const metadata = await readExistingLockOrReject(lockPath, requestedCanonicalOutputPath);
  if (!metadata) return;
  rejectIfLockIsNotRecoverable(metadata, requestedCanonicalOutputPath, lockPath);
  await recoverDeadOwnerLock(lockPath, metadata, requestedCanonicalOutputPath);
}

async function readExistingLockOrReject(lockPath: string, requestedCanonicalOutputPath: string): Promise<OutputLockMetadata | undefined> {
  try {
    return await readLockMetadata(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw lockError(`Briefkit output lock is unreadable or invalid for ${requestedCanonicalOutputPath}. Remove the lock only if no Briefkit build or publish is running: ${lockPath}`);
  }
}

function rejectIfLockIsNotRecoverable(metadata: OutputLockMetadata, requestedCanonicalOutputPath: string, lockPath: string): void {
  if (metadata.canonicalOutputPath !== requestedCanonicalOutputPath) {
    throw lockError(`Briefkit output lock metadata does not match ${requestedCanonicalOutputPath}. Remove the lock only if no Briefkit build or publish is running: ${lockPath}`);
  }
  if (metadata.hostname !== os.hostname()) {
    throw lockError(`Briefkit output is locked by another host for ${requestedCanonicalOutputPath}: ${metadata.hostname} pid ${metadata.pid}. Lock: ${lockPath}`);
  }
  if (isPidLive(metadata.pid)) {
    throw lockError(`Briefkit output is locked by another ${metadata.purpose} for ${requestedCanonicalOutputPath}: ${metadata.hostname} pid ${metadata.pid}. Lock: ${lockPath}`);
  }
}

async function recoverDeadOwnerLock(lockPath: string, staleMetadata: OutputLockMetadata, requestedCanonicalOutputPath: string): Promise<void> {
  const recoveryGuardPath = `${lockPath}.recovery`;
  const guardMetadata = lockMetadata(crypto.randomUUID(), 'build', requestedCanonicalOutputPath);
  const guardClaim = await tryClaimLockFile(recoveryGuardPath, guardMetadata);
  if (guardClaim !== 'claimed') {
    throw lockError(`Briefkit output lock recovery is already in progress for ${requestedCanonicalOutputPath}. Retry shortly, or remove ${recoveryGuardPath} only if no Briefkit build or publish is running.`);
  }

  const recoverySnapshotPath = `${lockPath}.recovery-snapshot-${process.pid}-${crypto.randomUUID()}`;
  try {
    let currentMetadata: OutputLockMetadata | undefined;
    try {
      await fs.link(lockPath, recoverySnapshotPath);
      currentMetadata = await readExistingLockOrReject(recoverySnapshotPath, requestedCanonicalOutputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!currentMetadata) return;
    rejectIfLockChangedDuringRecovery(currentMetadata, staleMetadata, requestedCanonicalOutputPath, lockPath);
    rejectIfLockIsNotRecoverable(currentMetadata, requestedCanonicalOutputPath, lockPath);
    if (await pathsShareInode(lockPath, recoverySnapshotPath)) {
      await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } finally {
    await fs.rm(recoverySnapshotPath, { force: true });
    await releaseOutputLock(recoveryGuardPath, guardMetadata.token).catch(() => undefined);
  }
}

function rejectIfLockChangedDuringRecovery(currentMetadata: OutputLockMetadata, staleMetadata: OutputLockMetadata, requestedCanonicalOutputPath: string, lockPath: string): void {
  if (currentMetadata.token === staleMetadata.token) return;
  throw lockError(`Briefkit output lock changed during stale recovery for ${requestedCanonicalOutputPath}. Retry the command. Lock: ${lockPath}`);
}

async function readLockMetadata(lockPath: string): Promise<OutputLockMetadata> {
  const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Partial<OutputLockMetadata> & { version?: unknown };
  if (parsed.version !== LOCK_VERSION) throw new Error('Unsupported lock version');
  if (!isNonEmptyString(parsed.token)) throw new Error('Invalid lock token');
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) throw new Error('Invalid lock pid');
  if (!isNonEmptyString(parsed.hostname)) throw new Error('Invalid lock hostname');
  if (parsed.purpose !== 'build' && parsed.purpose !== 'publish') throw new Error('Invalid lock purpose');
  if (!isNonEmptyString(parsed.canonicalOutputPath)) throw new Error('Invalid lock canonical output');
  if (!isNonEmptyString(parsed.createdAt)) throw new Error('Invalid lock timestamp');
  return parsed as OutputLockMetadata;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function pathsShareInode(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function atomicLinkError(lockPath: string, error: unknown): Error {
  return lockError(`Briefkit could not create an atomic output lock at ${lockPath}. This filesystem may not support hard-link locking. Aborting rather than risking concurrent writers. ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lockError(message: string): Error {
  const error = new Error(message);
  error.name = 'BriefkitOutputLockError';
  return error;
}
