import fs from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_OWNERSHIP_MARKER = '.briefkit-output.json';

interface OutputMarker {
  owner: 'briefkit';
  version: 1;
}

const EXPECTED_MARKER: OutputMarker = { owner: 'briefkit', version: 1 };

export async function assertCanPrepareOutputDirectory(outDir: string, reportDir: string): Promise<void> {
  const paths = await resolveOutputPolicyPaths(outDir, reportDir);

  rejectUnsafeOutputPath(paths);

  const entries = await readDirectoryEntriesIfPresent(paths.outputPath);
  if (entries.length === 0) return;

  if (await hasBriefkitOwnershipMarker(paths.outputPath)) return;

  throw new Error(`Refusing to delete non-empty output directory without Briefkit ownership marker: ${outDir}. See README "Requirements and output ownership" for safe recovery steps.`);
}

export async function writeOutputOwnershipMarker(outDir: string): Promise<void> {
  await fs.writeFile(path.join(outDir, OUTPUT_OWNERSHIP_MARKER), `${JSON.stringify(EXPECTED_MARKER, null, 2)}\n`, 'utf8');
}

export function isOutputOwnershipMarker(relativeFilePath: string): boolean {
  return relativeFilePath.split(path.sep).join('/') === OUTPUT_OWNERSHIP_MARKER;
}

async function resolveOutputPolicyPaths(outDir: string, reportDir: string): Promise<{ outputPath: string; reportPath: string; cwdPath: string; homePath: string; rootPath: string }> {
  return {
    outputPath: await canonicalPathForPolicy(outDir),
    reportPath: await canonicalPathForPolicy(reportDir),
    cwdPath: await canonicalPathForPolicy(process.cwd()),
    homePath: await canonicalPathForPolicy(process.env.HOME ?? ''),
    rootPath: path.parse(path.resolve(outDir)).root,
  };
}

async function canonicalPathForPolicy(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  try {
    return await fs.realpath(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return await canonicalPathForMissingTarget(resolvedPath);
  }
}

async function canonicalPathForMissingTarget(filePath: string): Promise<string> {
  const parentPath = path.dirname(filePath);
  if (parentPath === filePath) return filePath;

  try {
    return path.join(await fs.realpath(parentPath), path.basename(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(await canonicalPathForMissingTarget(parentPath), path.basename(filePath));
  }
}

function rejectUnsafeOutputPath(paths: { outputPath: string; reportPath: string; cwdPath: string; homePath: string; rootPath: string }): void {
  const outputPath = removeTrailingSeparator(paths.outputPath);
  const reportPath = removeTrailingSeparator(paths.reportPath);
  const cwdPath = removeTrailingSeparator(paths.cwdPath);
  const homePath = removeTrailingSeparator(paths.homePath);
  const rootPath = removeTrailingSeparator(paths.rootPath);

  if (outputPath === rootPath) throw new Error('Refusing to use filesystem root as Briefkit output directory.');
  if (outputPath === homePath) throw new Error('Refusing to use home directory as Briefkit output directory.');
  if (outputPath === cwdPath) throw new Error('Refusing to use current working directory as Briefkit output directory.');
  if (outputPath === reportPath) throw new Error('Refusing to use report directory as Briefkit output directory.');
  if (isAncestorPath(outputPath, reportPath)) throw new Error('Refusing to use an ancestor of the report directory as Briefkit output directory.');
}

function removeTrailingSeparator(filePath: string): string {
  const parsed = path.parse(filePath);
  if (filePath === parsed.root) return filePath;
  return filePath.replace(/[\\/]+$/, '');
}

function isAncestorPath(candidateAncestor: string, descendant: string): boolean {
  const relativePath = path.relative(candidateAncestor, descendant);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function readDirectoryEntriesIfPresent(directoryPath: string): Promise<string[]> {
  try {
    return await fs.readdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function hasBriefkitOwnershipMarker(outDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(outDir, OUTPUT_OWNERSHIP_MARKER), 'utf8')) as Partial<OutputMarker>;
    return marker.owner === EXPECTED_MARKER.owner && marker.version === EXPECTED_MARKER.version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
