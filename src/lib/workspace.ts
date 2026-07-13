import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import matter from 'gray-matter';
import { calculateTableWidths } from './tableWidths.js';
import type { ColorMode, PageInfo, ReportInfo } from './types.js';

const require = createRequire(import.meta.url);

export interface WorkspaceOptions {
  mode: 'dev' | 'build';
  colorMode: ColorMode;
  outDir?: string;
  port?: number;
  site?: string;
}

export interface WorkspaceInfo {
  dir: string;
  outDir: string;
}

export async function createWorkspace(report: ReportInfo, options: WorkspaceOptions): Promise<WorkspaceInfo> {
  const workspaceDir = workspacePath(report.reportDir, options.port);
  const outDir = path.resolve(options.outDir ?? path.join(report.reportDir, 'brief'));
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true });

  await writeJson(path.join(workspaceDir, 'package.json'), {
    type: 'module',
    dependencies: {},
  });
  await linkNodeModules(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, 'astro.config.mjs'), astroConfig(report.reportDir, outDir, workspaceDir, options.site), 'utf8');
  await syncWorkspace(workspaceDir, report, options);

  return { dir: workspaceDir, outDir };
}

export async function syncWorkspace(workspaceDir: string, report: ReportInfo, options: WorkspaceOptions): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true });
  const stagingDir = path.join(workspaceDir, `.briefkit-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    await resetGeneratedDir(path.join(stagingDir, 'src', 'generated'));
    await resetGeneratedDir(path.join(stagingDir, 'src', 'pages'));
    await resetGeneratedDir(path.join(stagingDir, 'src', 'processed'));

    await writeJson(path.join(stagingDir, 'src', 'generated', 'report-data.json'), {
      reportDir: report.reportDir,
      title: report.title,
      author: report.config.author,
      buildTime: new Date().toLocaleString(),
      colorMode: options.colorMode,
      pages: report.pages.map((page) => ({
        file: page.file,
        route: page.route,
        title: page.title,
        description: page.description,
        image: page.image,
        layout: page.layout,
        customLayout: page.customLayout,
      })),
    });
    await preparePublicDir(stagingDir, report.reportDir, await reportUsesMermaid(report.reportDir, report.pages));

    for (const page of report.pages) {
      await writeProcessedPage(stagingDir, page, report.title);
      await writePageWrapper(stagingDir, workspaceDir, page);
    }

    await promoteGeneratedWorkspace(stagingDir, workspaceDir);
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}


async function promoteGeneratedWorkspace(stagingDir: string, workspaceDir: string): Promise<void> {
  const generatedDirs = [
    [path.join(stagingDir, 'src', 'generated'), path.join(workspaceDir, 'src', 'generated')],
    [path.join(stagingDir, 'src', 'pages'), path.join(workspaceDir, 'src', 'pages')],
    [path.join(stagingDir, 'src', 'processed'), path.join(workspaceDir, 'src', 'processed')],
    [path.join(stagingDir, 'public'), path.join(workspaceDir, 'public')],
  ];

  for (const [_source, destination] of generatedDirs) {
    await fs.rm(destination, { recursive: true, force: true });
  }
  for (const [source, destination] of generatedDirs) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }
  await fs.rm(stagingDir, { recursive: true, force: true });
}

function workspacePath(reportDir: string, port?: number): string {
  const slug = path.basename(reportDir).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'report';
  const hash = crypto.createHash('sha1').update(reportDir).digest('hex').slice(0, 8);
  const suffix = port ? `-${port}` : '';
  return path.join(os.tmpdir(), 'briefkit', `${slug}-${hash}${suffix}`);
}

function packageRoot(): string {
  return path.resolve(path.join(import.meta.dirname, '..', '..'));
}

async function reportUsesMermaid(reportDir: string, pages: PageInfo[]): Promise<boolean> {
  const sourceFiles = new Set(pages.map((page) => page.absolutePath));
  await collectComponentSourceFiles(path.join(reportDir, 'components'), sourceFiles);

  for (const sourceFile of sourceFiles) {
    const source = await fs.readFile(sourceFile, 'utf8');
    if (/```\s*mermaid\b/i.test(source) || /<Mermaid(?:\s|>|\/)/.test(source)) return true;
  }
  return false;
}

async function collectComponentSourceFiles(componentDir: string, files: Set<string>): Promise<void> {
  if (!(await exists(componentDir))) return;

  const entries = await fs.readdir(componentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(componentDir, entry.name);
    if (entry.isDirectory()) {
      await collectComponentSourceFiles(entryPath, files);
    } else if (entry.isFile() && isComponentSourceFile(entry.name)) {
      files.add(entryPath);
    }
  }
}

function isComponentSourceFile(fileName: string): boolean {
  return ['.astro', '.tsx', '.jsx', '.mdx', '.md'].includes(path.extname(fileName).toLowerCase());
}

async function preparePublicDir(workspaceDir: string, reportDir: string, includeMermaidAssets: boolean): Promise<void> {
  const publicDir = path.join(workspaceDir, 'public');
  await resetGeneratedDir(publicDir);
  await copyDirIfExists(path.join(reportDir, 'public'), publicDir);
  if (includeMermaidAssets) await copyMermaidAssets(publicDir);
}

async function resetGeneratedDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyMermaidAssets(publicDir: string): Promise<void> {
  const mermaidDist = path.dirname(require.resolve('mermaid/dist/mermaid.esm.min.mjs'));
  const mermaidPublicDir = path.join(publicDir, '_briefkit', 'mermaid');
  await fs.mkdir(mermaidPublicDir, { recursive: true });
  await fs.copyFile(
    path.join(mermaidDist, 'mermaid.esm.min.mjs'),
    path.join(mermaidPublicDir, 'mermaid.esm.min.mjs'),
  );
  await copyDir(
    path.join(mermaidDist, 'chunks', 'mermaid.esm.min'),
    path.join(mermaidPublicDir, 'chunks', 'mermaid.esm.min'),
    (filePath) => filePath.endsWith('.mjs'),
  );
}

async function copyDirIfExists(source: string, destination: string): Promise<void> {
  if (await exists(source)) await copyDir(source, destination);
}

async function copyDir(source: string, destination: string, shouldCopyFile: (filePath: string) => boolean = () => true): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath, shouldCopyFile);
    } else if (entry.isFile() && shouldCopyFile(sourcePath)) {
      await fs.copyFile(sourcePath, destinationPath);
    }
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

function astroConfig(reportDir: string, outDir: string, workspaceDir: string, site?: string): string {
  const packageRootPath = packageRoot();
  const publicDir = path.join(workspaceDir, 'public');
  const cacheDir = path.join(workspaceDir, '.astro');
  return `import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import path from 'node:path';
import YAML from 'yaml';
import briefkitTables from ${JSON.stringify(path.join(packageRootPath, 'src', 'lib', 'rehypeTables.ts'))};
import briefkitMermaid from ${JSON.stringify(path.join(packageRootPath, 'src', 'lib', 'rehypeMermaid.ts'))};

function yamlPlugin() {
  return {
    name: 'briefkit-yaml',
    transform(source, id) {
      if (!id.endsWith('.yaml') && !id.endsWith('.yml')) return null;
      return { code: 'export default ' + JSON.stringify(YAML.parse(source)) + ';', map: null };
    }
  };
}

export default defineConfig({
  output: 'static',
  site: ${JSON.stringify(site)},
  outDir: ${JSON.stringify(outDir)},
  publicDir: ${JSON.stringify(publicDir)},
  cacheDir: ${JSON.stringify(cacheDir)},
  devToolbar: { enabled: false },
  markdown: { processor: unified({ rehypePlugins: [briefkitTables, briefkitMermaid] }) },
  integrations: [mdx()],
  vite: {
    plugins: [yamlPlugin()],
    resolve: {
      alias: {
        briefkit: ${JSON.stringify(path.join(packageRootPath, 'src', 'index.ts'))},
        '@report': ${JSON.stringify(reportDir)}
      }
    },
    server: {
      fs: {
        allow: [${JSON.stringify(reportDir)}, ${JSON.stringify(packageRootPath)}]
      }
    }
  }
});
`;
}

async function writePageWrapper(targetWorkspaceDir: string, importWorkspaceDir: string, page: PageInfo): Promise<void> {
  const routeFile = routeToWrapperPath(targetWorkspaceDir, page.route);
  await fs.mkdir(path.dirname(routeFile), { recursive: true });
  await fs.writeFile(routeFile, pageWrapperSource(importWorkspaceDir, page), 'utf8');
}

function routeToWrapperPath(workspaceDir: string, route: string): string {
  if (route === '/') return path.join(workspaceDir, 'src', 'pages', 'index.astro');
  const routeName = route.replace(/^\/+|\/+$/g, '');
  return path.join(workspaceDir, 'src', 'pages', routeName, 'index.astro');
}

async function writeProcessedPage(workspaceDir: string, page: PageInfo, reportTitle: string): Promise<void> {
  const source = await fs.readFile(page.absolutePath, 'utf8');
  const parsed = matter(source);
  warnIfReportPageStartsWithH1(page, parsed.content);
  const contentWithoutDuplicateTitle = removeDuplicateTitleHeading(parsed.content, [page.title, reportTitle]);
  const normalizedContent = injectHtmlTableColgroups(contentWithoutDuplicateTitle);
  const processed = `${matter.stringify(normalizedContent, parsed.data).trimEnd()}\n\nexport const briefkitHeadingOrder = ${JSON.stringify(extractHeadingOrder(normalizedContent))};\n`;
  const targetPath = processedPagePath(page, workspaceDir);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, processed, 'utf8');
}

function processedPagePath(page: PageInfo, workspaceDir?: string): string {
  const root = workspaceDir ?? workspacePath(path.dirname(page.absolutePath));
  const processedFile = page.file.replace(/\.md$/i, '.mdx');
  return path.join(root, 'src', 'processed', processedFile);
}

function warnIfReportPageStartsWithH1(page: PageInfo, content: string): void {
  if (page.layout !== 'report') return;
  const headingText = firstH1Text(content);
  if (!headingText) return;
  console.warn(`Briefkit warning: ${page.file} starts with an H1 ("${headingText}"). The report layout already renders the page H1 ("${page.title}"). Move this text to frontmatter/config title, change it to ##, or start the page with content.`);
}

function firstH1Text(content: string): string | undefined {
  const markdownMatch = /^#\s+(.+)\n+/.exec(content);
  if (markdownMatch) return stripHeadingText(markdownMatch[1]);

  const htmlMatch = /^<h1[^>]*>(.*?)<\/h1>\s*/is.exec(content);
  if (htmlMatch) return stripHeadingText(htmlMatch[1].replace(/<[^>]+>/g, ''));

  return undefined;
}

function removeDuplicateTitleHeading(content: string, titles: string[]): string {
  const normalizedTitles = new Set(titles.map(normalizeTitle));
  const markdownHeading = /^#\s+(.+)\n+/;
  const markdownMatch = markdownHeading.exec(content);
  if (markdownMatch && normalizedTitles.has(normalizeTitle(markdownMatch[1]))) {
    return content.slice(markdownMatch[0].length);
  }

  const htmlHeading = /^<h1[^>]*>(.*?)<\/h1>\s*/is;
  const htmlMatch = htmlHeading.exec(content);
  if (htmlMatch && normalizedTitles.has(normalizeTitle(htmlMatch[1].replace(/<[^>]+>/g, '')))) {
    return content.slice(htmlMatch[0].length);
  }

  return content;
}

function normalizeTitle(value: string): string {
  return stripHeadingText(value).toLowerCase();
}

function stripHeadingText(value: string): string {
  return value.replace(/\s+#+\s*$/, '').replace(/[{}*_`~\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function extractHeadingOrder(content: string): Array<{ type: 'markdown' } | { type: 'html'; depth: number; slug: string; text: string }> {
  const visibleContent = maskFencedCodeBlocks(content);
  const entries: Array<{ index: number; type: 'markdown' } | { index: number; type: 'html'; depth: number; slug: string; text: string }> = [];
  const markdownHeadingPattern = /^ {0,3}(#{2,4})[ \t]+(.+)$/gm;
  const htmlHeadingPattern = /<h([2-4])([^>]*)>(.*?)<\/h\1>/gims;
  let match: RegExpExecArray | null;

  while ((match = markdownHeadingPattern.exec(visibleContent)) !== null) {
    entries.push({ index: match.index, type: 'markdown' });
  }

  while ((match = htmlHeadingPattern.exec(visibleContent)) !== null) {
    const slug = extractHeadingId(match[2]);
    const text = stripHeadingText(match[3].replace(/<[^>]+>/g, ''));
    if (slug && text && !isNonNavigableHeading(match[2])) {
      entries.push({ index: match.index, type: 'html', depth: Number(match[1]), slug, text });
    }
  }

  return entries.sort((left, right) => left.index - right.index).map(({ index: _index, ...entry }) => entry);
}

function extractHeadingId(attributes: string): string | undefined {
  return /\bid=["']([^"']+)["']/.exec(attributes)?.[1];
}

function isNonNavigableHeading(attributes: string): boolean {
  return /className=["'][^"']*(bk-callout-title|callout-title)[^"']*["']/.test(attributes)
    || /data-nav=["']false["']/.test(attributes);
}

function maskFencedCodeBlocks(content: string): string {
  let openFence: { character: '`' | '~'; length: number } | undefined;

  return content.split('\n').map((line) => {
    const fence = fenceMarker(line);
    if (!openFence && fence) {
      openFence = fence;
      return ' '.repeat(line.length);
    }
    if (!openFence) return line;

    if (fence?.character === openFence.character && fence.length >= openFence.length && fence.isClosing) {
      openFence = undefined;
    }
    return ' '.repeat(line.length);
  }).join('\n');
}

function fenceMarker(line: string): { character: '`' | '~'; length: number; isClosing: boolean } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
    isClosing: match[2].trim().length === 0,
  };
}

function injectHtmlTableColgroups(content: string): string {
  return content.replace(/<table(?![^>]*className=["'][^"']*bk-skip-normalize)([^>]*)>([\s\S]*?)<\/table>/gi, (match, attributes: string, body: string) => {
    if (/<colgroup[\s>]/i.test(body)) return match;
    const headers = extractHtmlHeaders(body);
    if (headers.length === 0) return match;
    const rows = extractHtmlRows(body);
    const colgroup = `<colgroup>${calculateTableWidths(headers, rows).map((width) => `<col style={{ width: '${width}%' }} />`).join('')}</colgroup>`;
    const normalizedAttributes = addClassNameAttribute(attributes, 'bk-normalized-table');
    return `<table${normalizedAttributes}>${colgroup}${body}</table>`;
  });
}

function extractHtmlHeaders(tableBody: string): string[] {
  const rowMatch = /<thead[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>[\s\S]*?<\/thead>/i.exec(tableBody) ?? /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(tableBody);
  if (!rowMatch) return [];
  return [...rowMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractHtmlRows(tableBody: string): string[][] {
  const bodyMatch = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(tableBody);
  const source = bodyMatch?.[1] ?? tableBody.replace(/<thead[\s\S]*?<\/thead>/i, '');
  return [...source.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...rowMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((cellMatch) => cellMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
}

function addClassNameAttribute(attributes: string, className: string): string {
  const classMatch = /className=["']([^"']*)["']/.exec(attributes);
  if (!classMatch) return `${attributes} className="${className}"`;
  if (classMatch[1].split(/\s+/).includes(className)) return attributes;
  return attributes.replace(classMatch[0], `className="${classMatch[1]} ${className}"`);
}

function pageWrapperSource(workspaceDir: string, page: PageInfo): string {
  const pagePath = processedPagePath(page, workspaceDir);
  const pageKey = page.file;
  const customLayout = page.customLayout;

  if (page.layout === 'none') {
    return `---
import Content from ${JSON.stringify(pagePath)};
---
<Content />
`;
  }

  if (page.layout === 'custom') {
    if (!customLayout) {
      throw new Error(`${page.file} uses layout: custom but does not set customLayout.`);
    }
    return `---
import CustomLayout from ${JSON.stringify(customLayout)};
import Content, { briefkitHeadingOrder, getHeadings } from ${JSON.stringify(pagePath)};
import reportData from ${JSON.stringify(relativeGeneratedImport(page.route, 'report-data.json'))};
const currentPageData = reportData.pages.find((page) => page.file === ${JSON.stringify(pageKey)});
if (!currentPageData) throw new Error('Briefkit could not find current page data for ${pageKey}.');
const currentPage = { ...currentPageData, headings: currentPageHeadings() };
function currentPageHeadings() {
  const compilerHeadings = getHeadings().filter((heading) => heading.depth >= 2 && heading.depth <= 4);
  const nextCompilerHeading = compilerHeadings[Symbol.iterator]();
  return briefkitHeadingOrder.flatMap((entry) => {
    if (entry.type === 'html') return [{ depth: entry.depth, slug: entry.slug, text: entry.text }];
    const next = nextCompilerHeading.next();
    return next.done ? [] : [next.value];
  });
}
---
<CustomLayout page={currentPage} report={reportData}>
  <Content />
</CustomLayout>
`;
  }

  return `---
import { ReportLayout } from 'briefkit';
import Content, { briefkitHeadingOrder, getHeadings } from ${JSON.stringify(pagePath)};
import reportData from ${JSON.stringify(relativeGeneratedImport(page.route, 'report-data.json'))};
const currentPageData = reportData.pages.find((page) => page.file === ${JSON.stringify(pageKey)});
if (!currentPageData) throw new Error('Briefkit could not find current page data for ${pageKey}.');
const currentPage = { ...currentPageData, headings: currentPageHeadings() };
const navPages = reportData.pages.map((page) => ({ title: page.title, route: relativePageHref(currentPage.route, page.route), current: page.file === ${JSON.stringify(pageKey)} }));
function currentPageHeadings() {
  const compilerHeadings = getHeadings().filter((heading) => heading.depth >= 2 && heading.depth <= 4);
  const nextCompilerHeading = compilerHeadings[Symbol.iterator]();
  return briefkitHeadingOrder.flatMap((entry) => {
    if (entry.type === 'html') return [{ depth: entry.depth, slug: entry.slug, text: entry.text }];
    const next = nextCompilerHeading.next();
    return next.done ? [] : [next.value];
  });
}
function relativePageHref(fromRoute, toRoute) {
  if (fromRoute === toRoute) return './';
  const edgeSlashes = new RegExp('^/+|/+$', 'g');
  const fromParts = fromRoute.replace(edgeSlashes, '').split('/').filter(Boolean);
  const toParts = toRoute.replace(edgeSlashes, '').split('/').filter(Boolean);
  const commonLength = firstDifferentIndex(fromParts, toParts);
  const up = '../'.repeat(Math.max(0, fromParts.length - commonLength));
  const down = toParts.slice(commonLength).join('/');
  return up + down + (down ? '/' : '') || './';
}
function firstDifferentIndex(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}
---
<ReportLayout
  title={currentPage.title}
  reportTitle={reportData.title}
  pages={navPages}
  headings={currentPage.headings}
  description={currentPage.description}
  image={currentPage.image}
  author={reportData.author}
  buildTime={reportData.buildTime}
  colorMode={reportData.colorMode}
  assetBase={relativePageHref(currentPage.route, '/')}
>
  <Content />
</ReportLayout>
`;
}

function relativeGeneratedImport(route: string, fileName: string): string {
  if (route === '/') return `../generated/${fileName}`;
  const depth = route.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).length;
  return `${'../'.repeat(depth + 1)}generated/${fileName}`;
}

async function linkNodeModules(workspaceDir: string): Promise<void> {
  const source = path.join(packageRoot(), 'node_modules');
  const target = path.join(workspaceDir, 'node_modules');
  try {
    await fs.symlink(source, target, 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
