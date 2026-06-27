import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { calculateTableWidths } from './tableWidths.js';
import type { ColorMode, PageInfo, ReportInfo } from './types.js';

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
  await fs.mkdir(path.join(workspaceDir, 'src', 'pages'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'src', 'generated'), { recursive: true });

  await writeJson(path.join(workspaceDir, 'package.json'), {
    type: 'module',
    dependencies: {},
  });
  await linkNodeModules(workspaceDir);

  await writeJson(path.join(workspaceDir, 'src', 'generated', 'report-data.json'), {
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
      headings: page.headings,
      layout: page.layout,
      customLayout: page.customLayout,
    })),
  });

  await fs.writeFile(path.join(workspaceDir, 'astro.config.mjs'), astroConfig(report.reportDir, outDir, workspaceDir, options.site), 'utf8');

  for (const page of report.pages) {
    await writeProcessedPage(workspaceDir, page);
    await writePageWrapper(workspaceDir, page);
  }

  return { dir: workspaceDir, outDir };
}

function workspacePath(reportDir: string, port?: number): string {
  const slug = path.basename(reportDir).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'report';
  const hash = crypto.createHash('sha1').update(reportDir).digest('hex').slice(0, 8);
  const suffix = port ? `-${port}` : '';
  return path.join(os.tmpdir(), 'briefkit', `${slug}-${hash}${suffix}`);
}

function astroConfig(reportDir: string, outDir: string, workspaceDir: string, site?: string): string {
  const packageRoot = path.resolve(path.join(import.meta.dirname, '..', '..'));
  const publicDir = path.join(reportDir, 'public');
  const cacheDir = path.join(workspaceDir, '.astro');
  return `import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import path from 'node:path';
import YAML from 'yaml';
import briefkitTables from ${JSON.stringify(path.join(packageRoot, 'src', 'lib', 'rehypeTables.ts'))};

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
  markdown: { rehypePlugins: [briefkitTables] },
  integrations: [mdx()],
  vite: {
    plugins: [yamlPlugin()],
    resolve: {
      alias: {
        briefkit: ${JSON.stringify(path.join(packageRoot, 'src', 'index.ts'))},
        '@report': ${JSON.stringify(reportDir)}
      }
    },
    server: {
      fs: {
        allow: [${JSON.stringify(reportDir)}, ${JSON.stringify(packageRoot)}]
      }
    }
  }
});
`;
}

async function writePageWrapper(workspaceDir: string, page: PageInfo): Promise<void> {
  const routeFile = routeToWrapperPath(workspaceDir, page.route);
  await fs.mkdir(path.dirname(routeFile), { recursive: true });
  await fs.writeFile(routeFile, pageWrapperSource(workspaceDir, page), 'utf8');
}

function routeToWrapperPath(workspaceDir: string, route: string): string {
  if (route === '/') return path.join(workspaceDir, 'src', 'pages', 'index.astro');
  const routeName = route.replace(/^\/+|\/+$/g, '');
  return path.join(workspaceDir, 'src', 'pages', routeName, 'index.astro');
}

async function writeProcessedPage(workspaceDir: string, page: PageInfo): Promise<void> {
  const source = await fs.readFile(page.absolutePath, 'utf8');
  const parsed = matter(source);
  const contentWithoutDuplicateTitle = removeDuplicateTitleHeading(parsed.content, page.title);
  const normalizedContent = normalizeSlashSpacingInMdx(injectHtmlTableColgroups(contentWithoutDuplicateTitle));
  const processed = matter.stringify(normalizedContent, parsed.data);
  const targetPath = processedPagePath(page, workspaceDir);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, processed, 'utf8');
}

function processedPagePath(page: PageInfo, workspaceDir?: string): string {
  const root = workspaceDir ?? workspacePath(path.dirname(page.absolutePath));
  const processedFile = page.file.replace(/\.md$/i, '.mdx');
  return path.join(root, 'src', 'processed', processedFile);
}

function removeDuplicateTitleHeading(content: string, title: string): string {
  const markdownHeading = /^#\s+(.+)\n+/;
  const markdownMatch = markdownHeading.exec(content);
  if (markdownMatch && normalizeTitle(markdownMatch[1]) === normalizeTitle(title)) {
    return content.slice(markdownMatch[0].length);
  }

  const htmlHeading = /^<h1[^>]*>(.*?)<\/h1>\s*/is;
  const htmlMatch = htmlHeading.exec(content);
  if (htmlMatch && normalizeTitle(htmlMatch[1].replace(/<[^>]+>/g, '')) === normalizeTitle(title)) {
    return content.slice(htmlMatch[0].length);
  }

  return content;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+#+\s*$/, '').replace(/[{}*_`~\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSlashSpacingInMdx(content: string): string {
  let inFence = false;
  return content.split('\n').map((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || /^\s*(import|export)\s/.test(line)) return line;
    return line.split(/(<[^>]+>)/g).map((part) => {
      if (part.startsWith('<') && part.endsWith('>')) return part;
      return normalizeSlashSpacingText(part);
    }).join('');
  }).join('\n');
}

function normalizeSlashSpacingText(value: string): string {
  const preserved: string[] = [];
  return value
    .replace(/(`[^`]*`|\[[^\]]*\]\([^)]+\))/g, (match) => {
      preserved.push(match);
      return `\u0000${preserved.length - 1}\u0000`;
    })
    .replace(/(?<=[A-Za-z0-9)])\/(?=[A-Za-z0-9(])/g, ' / ')
    .replace(/\s+\/\s+/g, ' / ')
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => preserved[Number(index)] ?? '');
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
import Content from ${JSON.stringify(pagePath)};
import reportData from ${JSON.stringify(relativeDataImport(page.route))};
const currentPage = reportData.pages.find((page) => page.file === ${JSON.stringify(pageKey)});
---
<CustomLayout page={currentPage} report={reportData}>
  <Content />
</CustomLayout>
`;
  }

  return `---
import { ReportLayout } from 'briefkit';
import Content from ${JSON.stringify(pagePath)};
import reportData from ${JSON.stringify(relativeDataImport(page.route))};
const currentPage = reportData.pages.find((page) => page.file === ${JSON.stringify(pageKey)});
const navPages = reportData.pages.map((page) => ({ title: page.title, route: relativePageHref(currentPage.route, page.route), current: page.file === ${JSON.stringify(pageKey)} }));
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
>
  <Content />
</ReportLayout>
`;
}

function relativeDataImport(route: string): string {
  if (route === '/') return '../generated/report-data.json';
  const depth = route.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).length;
  return `${'../'.repeat(depth + 1)}generated/report-data.json`;
}

async function linkNodeModules(workspaceDir: string): Promise<void> {
  const packageRoot = path.resolve(path.join(import.meta.dirname, '..', '..'));
  const source = path.join(packageRoot, 'node_modules');
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
