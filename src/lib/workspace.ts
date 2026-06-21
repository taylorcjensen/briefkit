import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ColorMode, PageInfo, ReportInfo } from './types.js';

export interface WorkspaceOptions {
  mode: 'dev' | 'build';
  colorMode: ColorMode;
  outDir?: string;
  port?: number;
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
      headings: page.headings,
      layout: page.layout,
      customLayout: page.customLayout,
    })),
  });

  await fs.writeFile(path.join(workspaceDir, 'astro.config.mjs'), astroConfig(report.reportDir, outDir), 'utf8');

  for (const page of report.pages) {
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

function astroConfig(reportDir: string, outDir: string): string {
  const packageRoot = path.resolve(path.join(import.meta.dirname, '..', '..'));
  const publicDir = path.join(reportDir, 'public');
  return `import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import path from 'node:path';
import YAML from 'yaml';

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
  outDir: ${JSON.stringify(outDir)},
  publicDir: ${JSON.stringify(publicDir)},
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
  await fs.writeFile(routeFile, pageWrapperSource(page), 'utf8');
}

function routeToWrapperPath(workspaceDir: string, route: string): string {
  if (route === '/') return path.join(workspaceDir, 'src', 'pages', 'index.astro');
  const routeName = route.replace(/^\/+|\/+$/g, '');
  return path.join(workspaceDir, 'src', 'pages', routeName, 'index.astro');
}

function pageWrapperSource(page: PageInfo): string {
  const pagePath = page.absolutePath;
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
const navPages = reportData.pages.map((page) => ({ title: page.title, route: page.route, current: page.file === ${JSON.stringify(pageKey)} }));
---
<ReportLayout
  title={currentPage.title}
  reportTitle={reportData.title}
  pages={navPages}
  headings={currentPage.headings}
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
