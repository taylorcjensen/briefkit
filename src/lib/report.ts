import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import type { BriefkitConfig, HeadingInfo, PageConfigEntry, PageInfo, ReportInfo } from './types.js';

const CONFIG_NAMES = ['briefkit.config.ts', 'briefkit.config.js', 'briefkit.config.mjs'];
const PAGE_EXTENSIONS = ['.mdx', '.md'];
const ROOT_PAGE_CANDIDATES = ['index.mdx', 'index.md', 'README.mdx', 'README.md'];

export async function loadReport(reportDirInput: string): Promise<ReportInfo> {
  const reportDir = path.resolve(reportDirInput);
  const config = await loadConfig(reportDir);
  const configuredEntries = normalizePageEntries(config.pages ?? []);
  const discoveredFiles = await discoverMdxFiles(reportDir, configuredEntries);

  if (discoveredFiles.length === 0) {
    throw new Error(`No Markdown pages found in ${reportDir}. Expected index.mdx, index.md, README.md, or pages/**/*.{md,mdx}.`);
  }

  const configuredFiles = new Set(configuredEntries.map((entry) => normalizeRelativePath(entry.file)));
  const configuredByFile = new Map(configuredEntries.map((entry) => [normalizeRelativePath(entry.file), entry]));

  const orderedFiles = [
    ...configuredEntries.map((entry) => normalizeRelativePath(entry.file)),
    ...discoveredFiles.filter((file) => !configuredFiles.has(file)).sort(comparePageFiles),
  ];

  const missingConfigured = orderedFiles.filter((file) => !discoveredFiles.includes(file));
  if (missingConfigured.length > 0) {
    throw new Error(`Configured page(s) not found: ${missingConfigured.join(', ')}`);
  }

  const pages = (await Promise.all(
    orderedFiles.map((file) => readPage(reportDir, file, configuredByFile.get(file))),
  )).filter((page) => !page.hidden);

  assertUniqueRoutes(pages);

  const indexPage = pages.find((page) => page.route === '/') ?? pages[0];
  const title = config.title ?? indexPage?.title ?? path.basename(reportDir);

  return { reportDir, config, title, pages };
}

async function loadConfig(reportDir: string): Promise<BriefkitConfig> {
  for (const configName of CONFIG_NAMES) {
    const configPath = path.join(reportDir, configName);
    if (await exists(configPath)) {
      const imported = await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
      return imported.default ?? imported;
    }
  }
  return {};
}

async function discoverMdxFiles(reportDir: string, configuredEntries: PageConfigEntry[]): Promise<string[]> {
  const files: string[] = [];
  for (const candidate of ROOT_PAGE_CANDIDATES) {
    if (await exists(path.join(reportDir, candidate))) {
      files.push(candidate);
      break;
    }
  }

  const pagesDir = path.join(reportDir, 'pages');
  if (await exists(pagesDir)) {
    await collectMdxFiles(pagesDir, pagesDir, files);
  }

  for (const entry of configuredEntries) {
    const file = normalizeRelativePath(entry.file);
    if (!isPageFile(file) || files.includes(file)) continue;
    if (await exists(path.join(reportDir, file))) files.push(file);
  }

  if (!hasIndexPage(files)) {
    throw new Error(`Report requires index.mdx, index.md, README.md, or pages/index.{md,mdx} in ${reportDir}.`);
  }

  return files.map(normalizeRelativePath);
}

async function collectMdxFiles(rootDir: string, currentDir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectMdxFiles(rootDir, entryPath, files);
      continue;
    }
    if (entry.isFile() && isPageFile(entry.name)) {
      files.push(normalizeRelativePath(path.join('pages', path.relative(rootDir, entryPath))));
    }
  }
}

async function readPage(reportDir: string, file: string, config?: PageConfigEntry): Promise<PageInfo> {
  const absolutePath = path.join(reportDir, file);
  const source = await fs.readFile(absolutePath, 'utf8');
  const parsed = matter(source);
  const data = parsed.data as Record<string, unknown>;
  const title = config?.title ?? stringValue(data.title) ?? titleFromContent(parsed.content) ?? titleFromFile(file);
  const route = normalizeRoute(config?.route ?? routeFromFile(file));
  const layout = normalizeLayout(data.layout);

  return {
    file,
    absolutePath,
    route,
    title,
    hidden: data.hidden === true,
    headings: extractHeadings(parsed.content),
    layout,
    customLayout: stringValue(data.customLayout),
  };
}

function normalizePageEntries(entries: (string | PageConfigEntry)[]): PageConfigEntry[] {
  return entries.map((entry) => typeof entry === 'string' ? { file: entry } : entry);
}

function normalizeRelativePath(file: string): string {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function comparePageFiles(a: string, b: string): number {
  if (isIndexPage(a)) return -1;
  if (isIndexPage(b)) return 1;
  return a.localeCompare(b);
}

function routeFromFile(file: string): string {
  if (isIndexPage(file)) return '/';
  return `/${path.basename(file, path.extname(file))}/`;
}

function normalizeRoute(route: string): string {
  if (route === '/') return route;
  return `/${route.replace(/^\/+|\/+$/g, '')}/`;
}

function titleFromFile(file: string): string {
  const baseName = path.basename(file, path.extname(file));
  if (baseName === 'index' || baseName.toLowerCase() === 'readme') return 'Index';
  return baseName.split(/[-_]/).filter(Boolean).map(capitalize).join(' ');
}

function isPageFile(file: string): boolean {
  return PAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function isIndexPage(file: string): boolean {
  const normalized = normalizeRelativePath(file).toLowerCase();
  return normalized === 'index.mdx'
    || normalized === 'index.md'
    || normalized === 'readme.mdx'
    || normalized === 'readme.md'
    || normalized === 'pages/index.mdx'
    || normalized === 'pages/index.md';
}

function hasIndexPage(files: string[]): boolean {
  return files.some(isIndexPage);
}

function titleFromContent(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  if (!match) return undefined;
  return stripMdx(match[1].replace(/\s+#+\s*$/, '').trim());
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeLayout(value: unknown): PageInfo['layout'] {
  if (value === 'none' || value === 'custom') return value;
  return 'report';
}

function extractHeadings(content: string): HeadingInfo[] {
  const matches: Array<{ index: number; depth: number; slug?: string; text: string }> = [];
  const usedSlugs = new Map<string, number>();
  const markdownHeadingPattern = /^(#{2,4})\s+(.+)$/gm;
  const htmlHeadingPattern = /<h([2-4])([^>]*)>(.*?)<\/h\1>/gims;
  let match: RegExpExecArray | null;

  while ((match = markdownHeadingPattern.exec(content)) !== null) {
    const rawText = match[2].replace(/\s+#+\s*$/, '').trim();
    const text = stripMdx(rawText);
    if (!text) continue;
    matches.push({ index: match.index, depth: match[1].length, text });
  }

  while ((match = htmlHeadingPattern.exec(content)) !== null) {
    if (isNonNavigableHeading(match[2])) continue;
    const text = stripMdx(match[3]);
    if (!text) continue;
    matches.push({
      index: match.index,
      depth: Number(match[1]),
      slug: extractId(match[2]),
      text,
    });
  }

  return matches
    .sort((a, b) => a.index - b.index)
    .map((heading) => ({
      depth: heading.depth,
      slug: uniqueSlug(heading.slug || slugify(heading.text), usedSlugs),
      text: heading.text,
    }));
}

function extractId(attributes: string): string | undefined {
  const match = /\sid=["']([^"']+)["']/.exec(attributes);
  return match?.[1];
}

function isNonNavigableHeading(attributes: string): boolean {
  return /className=["'][^"']*(bk-callout-title|callout-title)[^"']*["']/.test(attributes)
    || /data-nav=["']false["']/.test(attributes);
}

function stripMdx(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[{}*_`~\[\]]/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-') || 'section';
}

function uniqueSlug(slug: string, usedSlugs: Map<string, number>): string {
  const count = usedSlugs.get(slug) ?? 0;
  usedSlugs.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count + 1}`;
}

function assertUniqueRoutes(pages: PageInfo[]): void {
  const seen = new Map<string, string>();
  for (const page of pages) {
    const existing = seen.get(page.route);
    if (existing) {
      throw new Error(`Route collision: ${existing} and ${page.file} both render to ${page.route}. Add explicit routes in briefkit.config.`);
    }
    seen.set(page.route, page.file);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
