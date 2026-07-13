import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import type { BriefkitConfig, PageConfigEntry, PageInfo, ReportInfo } from './types.js';

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

  return { reportDir, config, title, pages: applyReportSeoDefaults(pages, config) };
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
  const description = config?.description ?? stringValue(data.description) ?? descriptionFromContent(parsed.content);
  const image = config?.image ?? stringValue(data.image) ?? firstImageFromContent(parsed.content);

  return {
    file,
    absolutePath,
    route,
    title,
    hidden: data.hidden === true,
    description,
    image,
    layout,
    customLayout: stringValue(data.customLayout),
  };
}

function normalizePageEntries(entries: (string | PageConfigEntry)[]): PageConfigEntry[] {
  return entries.map((entry) => typeof entry === 'string' ? { file: entry } : entry);
}

function applyReportSeoDefaults(pages: PageInfo[], config: BriefkitConfig): PageInfo[] {
  return pages.map((page) => ({
    ...page,
    description: page.description ?? config.description,
    image: page.image ?? config.image,
  }));
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

function descriptionFromContent(content: string): string | undefined {
  const text = stripMdx(removeNonProseContent(content)).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g)?.slice(0, 3).join(' ').trim();
  return truncateDescription(sentences || text);
}

function removeNonProseContent(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^import\s.+$/gm, '')
    .replace(/^export\s.+$/gm, '')
    .replace(/^#{1,6}\s+.+$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/<img\b[^>]*>/gi, '');
}

function truncateDescription(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).replace(/\s+\S*$/, '')}...`;
}

function firstImageFromContent(content: string): string | undefined {
  return firstMarkdownImage(content) ?? firstHtmlImage(content);
}

function firstMarkdownImage(content: string): string | undefined {
  const match = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(content);
  return match?.[1];
}

function firstHtmlImage(content: string): string | undefined {
  const match = /<img\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/i.exec(content);
  return match?.[1];
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

function stripMdx(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[{}*_`~\[\]]/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
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
