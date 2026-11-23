import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';

const namePattern = /^[a-z0-9][a-z0-9_-]*$/;

export function templateDirectory(): string {
  return path.join(os.homedir(), '.config', 'briefkit', 'templates');
}

function assertName(name: string): void {
  if (!namePattern.test(name)) throw new Error('Template name must contain lowercase letters, numbers, hyphens, or underscores and start with a letter or number.');
}

async function stat(pathname: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try { return await fs.lstat(pathname); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertRealDirectory(pathname: string): Promise<void> {
  const info = await stat(pathname);
  if (info && !info.isDirectory()) throw new Error(`Not a regular directory: ${pathname}`);
}

async function store(create: boolean): Promise<string> {
  const directory = templateDirectory();
  await assertRealDirectory(directory);
  if (create) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRealDirectory(directory);
  }
  return directory;
}

async function resolveTemplate(name: string): Promise<{ source: string; folder: boolean } | undefined> {
  assertName(name);
  const directory = await store(false);
  const file = path.join(directory, `${name}.md`);
  const folder = path.join(directory, name);
  const fileStat = await stat(file);
  const folderStat = await stat(folder);
  if (fileStat && folderStat) throw new Error(`Ambiguous template ${name}: both file and folder exist.`);
  if ((fileStat && !fileStat.isFile()) || (folderStat && !folderStat.isDirectory())) throw new Error(`Template ${name} is not a regular Markdown file or directory.`);
  if (fileStat) return { source: file, folder: false };
  if (folderStat) return { source: folder, folder: true };
  return undefined;
}

export async function listTemplates(): Promise<string[]> {
  const directory = await store(false);
  if (!await stat(directory)) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => (entry.isFile() && entry.name.endsWith('.md') && namePattern.test(entry.name.slice(0, -3)))
    || (entry.isDirectory() && namePattern.test(entry.name)))
    .map((entry) => `${entry.isDirectory() ? entry.name : entry.name.slice(0, -3)} (${entry.isDirectory() ? 'folder' : 'Markdown'})`)
    .sort();
}

async function assertAvailable(name: string): Promise<void> {
  if (await resolveTemplate(name)) throw new Error(`Template ${name} already exists; edit or remove it in ${templateDirectory()}.`);
}

export async function initTemplate(name: string, folder: boolean): Promise<string> {
  assertName(name);
  await store(true);
  await assertAvailable(name);
  const destination = path.join(templateDirectory(), folder ? name : `${name}.md`);
  const content = `---\ntitle: ${name}\n---\n\n> **Decision:** State the recommended action and its condition.\n\n## Facts\n\n| Fact | Value | Source | Caveat |\n|---|---|---|---|\n| Example | Replace with evidence | Link to source | Unknown until checked |\n\n## Next step\n\nName the owner and the next decision.\n`;
  if (folder) {
    await fs.mkdir(destination);
    try { await fs.writeFile(path.join(destination, 'index.md'), content, { flag: 'wx' }); }
    catch (error) { await fs.rm(destination, { recursive: true }); throw error; }
  } else {
    await fs.writeFile(destination, content, { flag: 'wx' });
  }
  return destination;
}

async function assertRegularTree(source: string): Promise<void> {
  const info = await fs.lstat(source);
  if (info.isFile()) return;
  if (!info.isDirectory()) throw new Error(`Templates cannot contain symlinks or special files: ${source}`);
  for (const entry of await fs.readdir(source)) await assertRegularTree(path.join(source, entry));
}

async function copyTemplate(source: string, destination: string, folder: boolean): Promise<void> {
  await assertRegularTree(source);
  const target = path.resolve(destination);
  if (target === path.resolve(source) || (folder && target.startsWith(`${path.resolve(source)}${path.sep}`))) throw new Error('Destination must be outside the template source.');
  // Require an existing parent: never create surprising intermediate directories or follow a symlinked destination.
  const parent = path.dirname(target);
  if (!((await fs.lstat(parent)).isDirectory())) throw new Error(`Destination parent is not a regular directory: ${parent}`);
  if (folder) {
    await fs.mkdir(target); // EEXIST also protects an existing symlink or empty directory.
    try { await copyFolderContents(source, target); }
    catch (error) { await fs.rm(target, { recursive: true }); throw error; }
  } else {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

async function copyFolderContents(source: string, destination: string): Promise<void> {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to);
      await copyFolderContents(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    } else throw new Error(`Templates cannot contain symlinks or special files: ${from}`);
  }
}

export async function useTemplate(name: string, destination?: string): Promise<string> {
  const template = await resolveTemplate(name);
  if (!template) throw new Error(`Template ${name} not found in ${templateDirectory()}. Install an example explicitly or run templates init ${name}.`);
  const target = path.resolve(destination ?? (template.folder ? name : `${name}.md`));
  await copyTemplate(template.source, target, template.folder);
  return target;
}

export async function installTemplate(sourcePath: string, name?: string): Promise<string> {
  const source = path.resolve(sourcePath);
  const info = await fs.lstat(source);
  if (!info.isDirectory() && !(info.isFile() && path.extname(source).toLowerCase() === '.md')) throw new Error('Install source must be a regular Markdown .md file or report directory.');
  const folder = info.isDirectory();
  const templateName = name ?? (folder ? path.basename(source) : path.basename(source, path.extname(source)));
  assertName(templateName);
  if (folder && !await stat(path.join(source, 'index.md')) && !await stat(path.join(source, 'index.mdx')) && !await stat(path.join(source, 'README.md'))) {
    throw new Error('Report-folder templates need index.md, index.mdx, or README.md.');
  }
  await store(true);
  await assertAvailable(templateName);
  const target = path.join(templateDirectory(), folder ? templateName : `${templateName}.md`);
  await copyTemplate(source, target, folder);
  return target;
}

export async function runTemplatesCli(args: string[]): Promise<void> {
  const [command, first, second, ...rest] = args;
  if (rest.length || !['init', 'list', 'use', 'install'].includes(command ?? '')) throw new Error('Usage: briefkit templates init <name> [--folder] | list | use <name> [destination] | install <local-example-path> [name]');
  let result: string;
  if (command === 'list') {
    if (first) throw new Error('Usage: briefkit templates list');
    const entries = await listTemplates();
    console.log(entries.length ? entries.join('\n') : `No templates in ${templateDirectory()}.`);
    return;
  }
  if (!first || first.startsWith('-')) throw new Error(`Usage: briefkit templates ${command} <${command === 'install' ? 'local-example-path' : 'name'}>`);
  if (command === 'init') {
    if (second && second !== '--folder') throw new Error('Usage: briefkit templates init <name> [--folder]');
    result = await initTemplate(first, second === '--folder');
  } else if (command === 'use') {
    if (second?.startsWith('--')) throw new Error(`Unknown option: ${second}`);
    result = await useTemplate(first, second);
  } else {
    if (second?.startsWith('--')) throw new Error(`Unknown option: ${second}`);
    result = await installTemplate(first, second);
  }
  console.log(`Template ${command} complete: ${result}`);
}
