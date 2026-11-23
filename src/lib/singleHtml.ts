import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as astroBuild } from 'astro';
import islandRuntime from 'astro/runtime/server/astro-island.prebuilt.js';
import { build as bundleJs } from 'esbuild';
import * as parse5 from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { acquireOutputLock } from './outputLock.js';
import { resolveSafeOutputPath } from './outputPolicy.js';
import { normalizePortableAssetUrls } from './portableAssetUrls.js';
import { cleanupWorkspace, createWorkspace } from './workspace.js';
import type { ColorMode, ReportInfo } from './types.js';

type Node = parse5.DefaultTreeAdapterMap['node'];
type Element = parse5.DefaultTreeAdapterMap['element'];
const OWNER = 'briefkit-single-html-v1';
const mime: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

export async function buildSingleHtml(report: ReportInfo, destination: string, colorMode: ColorMode): Promise<string> {
  if (report.pages.length !== 1 || report.pages[0].route !== '/') {
    throw new Error('--single-html requires exactly one visible page at the / route.');
  }
  if (path.extname(destination).toLowerCase() !== '.html') throw new Error('--single-html --out must end in .html.');
  const output = await resolveSafeOutputPath(destination, report.reportDir);
  const marker = `${output}.briefkit-owner.json`;
  const lock = await acquireOutputLock(output, 'build');
  let workspace: string | undefined;
  let staging: string | undefined;
  try {
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'briefkit-single-html-'));
    await assertOwnedOutput(output, marker);
    const created = await createWorkspace(report, { mode: 'build', colorMode, outDir: path.join(staging, 'site') });
    workspace = created.dir;
    const previousCwd = process.cwd();
    try {
      process.chdir(created.dir);
      await astroBuild({ root: created.dir });
    } finally {
      process.chdir(previousCwd);
    }
    const site = created.outDir;
    await copyPublicFallback(path.join(report.reportDir, 'public'), site);
    await normalizePortableAssetUrls(site);
    const files = await listFiles(site);
    const htmlFiles = files.filter((file) => file.endsWith('.html'));
    if (htmlFiles.length !== 1 || path.relative(site, htmlFiles[0]) !== 'index.html') {
      throw new Error('--single-html requires one emitted index.html page; extra HTML output is unsupported.');
    }
    const html = await inlineHtml(site, htmlFiles[0]);
    await assertOwnedOutput(output, marker);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const stagedFile = `${output}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(stagedFile, html, { flag: 'wx' });
      await fs.rename(stagedFile, output);
      const stagedMarker = `${marker}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        await fs.writeFile(stagedMarker, JSON.stringify({ owner: OWNER, file: path.basename(output), sha256: hash(html) }) + '\n', { flag: 'wx' });
        await fs.rename(stagedMarker, marker);
      } finally {
        await fs.rm(stagedMarker, { force: true });
      }
    } finally {
      await fs.rm(stagedFile, { force: true });
    }
    return output;
  } finally {
    if (workspace) await cleanupWorkspace(workspace);
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    await lock.release();
  }
}

async function assertOwnedOutput(output: string, marker: string): Promise<void> {
  let existing: Buffer | undefined;
  try { existing = await fs.readFile(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let owner: { owner?: string; file?: string; sha256?: string } | undefined;
  try {
    if (!(await fs.lstat(marker)).isFile()) throw new Error('Marker is not a regular file');
    owner = JSON.parse(await fs.readFile(marker, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Refusing to replace invalid Briefkit ownership marker: ${marker}`);
    }
  }
  if (!owner && !existing) return;
  if (!owner) throw new Error(`Refusing to replace existing HTML without Briefkit ownership marker: ${output}`);
  if (owner.owner !== OWNER || owner.file !== path.basename(output) || (existing && owner.sha256 !== hash(existing))) {
    throw new Error(`Refusing to replace modified or unowned HTML: ${output}`);
  }
}

function hash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function listFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(item));
    else if (entry.isFile()) result.push(item);
    else throw new Error(`--single-html does not support linked output assets: ${item}`);
  }
  return result;
}

async function copyPublicFallback(source: string, site: string): Promise<void> {
  try { await fs.access(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await fs.cp(source, site, { recursive: true, force: true });
}

async function inlineHtml(site: string, htmlFile: string): Promise<string> {
  const source = await fs.readFile(htmlFile, 'utf8');
  if (source.includes('data-bk-response-form')) throw new Error('--single-html cannot render UserRespond forms without a response server.');
  const document = parse5.parse(source);
  const root = await fs.realpath(site);
  const context = { root, diagrams: false };
  context.diagrams = hasDiagram(document);
  await embedChartIslands(document, htmlFile, root);
  await inlineNode(document, htmlFile, context);
  return parse5.serialize(document);
}

// Bundle the renderer and all charts in one module so their React singleton is shared.
// A single import-map entry keeps the bundle in the file once, even with several charts.
async function embedChartIslands(document: Node, base: string, root: string): Promise<void> {
  const elements: Element[] = [];
  function visit(node: Node) {
    if (isElement(node)) elements.push(node);
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(document);
  const islands = elements.filter((el) => el.tagName === 'astro-island');
  if (!islands.length) return;
  const imports = [];
  let renderer: string | undefined;
  for (const [i, el] of islands.entries()) {
    const file = getAttr(el, 'component-url') ?? '';
    const runtime = getAttr(el, 'renderer-url') ?? '';
    if (!/\.recharts-\d+\.[^/]+\.js$/.test(file) || getAttr(el, 'component-export') !== 'default' || getAttr(el, 'client') !== 'only' || getAttr(el, 'before-hydration-url') || !runtime || (renderer && renderer !== runtime)) {
      throw new Error('--single-html supports only Briefkit Recharts islands.');
    }
    renderer = runtime;
    imports.push(`export { default as Chart${i} } from ${JSON.stringify(await resolveAsset(file, base, root))};`);
    setAttr(el, 'component-url', 'briefkit-offline-charts');
    setAttr(el, 'component-export', `Chart${i}`);
    setAttr(el, 'renderer-url', 'briefkit-offline-charts');
  }
  imports.push(`export { default } from ${JSON.stringify(await resolveAsset(renderer!, base, root))};`);
  const bundle = await bundleJs({ stdin: { contents: imports.join('\n'), resolveDir: root }, bundle: true, write: false, minify: true, format: 'esm', platform: 'browser' });
  const code = bundle.outputFiles[0].text;
  if (bundle.outputFiles.length !== 1 || /\bimport\.meta\b|(?:^|[^.\w])(?:fetch|Worker|SharedWorker)\s*\(|\bnew\s+URL\s*\(|\bimport\s*\(/.test(code)) throw new Error('--single-html cannot embed a chart with external runtime dependencies.');
  const data = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const head = elements.find((el) => el.tagName === 'head')!;
  const script = parse5.parseFragment(`<script type="importmap">${JSON.stringify({ imports: { 'briefkit-offline-charts': data } })}</script>`).childNodes[0];
  script.parentNode = head;
  head.childNodes.unshift(script);
}

function hasDiagram(node: Node): boolean {
  if (isElement(node) && getAttr(node, 'data-bk-mermaid-source') !== undefined) return true;
  return 'childNodes' in node && node.childNodes.some(hasDiagram);
}

async function inlineNode(node: Node, base: string, context: { root: string; diagrams: boolean }): Promise<void> {
  if (isElement(node)) {
    const tag = node.tagName;
    if (tag === 'base' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      throw new Error(`--single-html does not support <${tag}> rendering dependencies.`);
    }
    if (tag === 'script') {
      const src = getAttr(node, 'src');
      if (src !== undefined) setAttr(node, 'src', await localData(src, base, context.root, getAttr(node, 'type') === 'module' ? 'script' : 'classic-script'));
      const mermaid = getAttr(node, 'data-bk-mermaid-url');
      if (mermaid === undefined && src === undefined && node.childNodes.some((child) => 'value' in child && child.value.trim() !== islandRuntime.trim() && /(?:^|[^.\w])(?:fetch|Worker|SharedWorker)\s*\(|\bimport\s*\(|\bnew\s+URL\s*\(/.test(child.value))) {
        throw new Error('--single-html does not support inline scripts with runtime fetch, import, worker, or URL dependencies.');
      }
      if (mermaid !== undefined && !context.diagrams) {
        setAttr(node, 'data-bk-mermaid-url', '');
        for (const child of node.childNodes) if ('value' in child) child.value = '';
      }
      if (mermaid !== undefined && context.diagrams) {
        const bundled = await localData(mermaid, base, context.root, 'script');
        setAttr(node, 'data-bk-mermaid-url', '');
        // document.currentScript is null in module scripts, including file:// modules.
        // Replace the built-in fallback as well so its dynamic import stays offline.
        for (const child of node.childNodes) {
          if ('value' in child) child.value = child.value.replace("'./_briefkit/mermaid/mermaid.esm.min.mjs'", JSON.stringify(bundled));
        }
      }
    } else if (tag === 'link') {
      const rel = (getAttr(node, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = getAttr(node, 'href');
      if (href !== undefined && rel.some((item) => ['stylesheet', 'icon', 'preload', 'modulepreload', 'apple-touch-icon'].includes(item))) {
        const kind = rel.includes('stylesheet') ? 'css' : rel.includes('modulepreload') || getAttr(node, 'as') === 'script' ? 'script' : 'asset';
        setAttr(node, 'href', await localData(href, base, context.root, kind));
      } else if (href && !isExternal(href)) {
        throw new Error(`--single-html cannot embed unsupported <link> asset: ${href}`);
      }
    } else if (tag === 'a' || tag === 'form') {
      const href = getAttr(node, tag === 'a' ? 'href' : 'action');
      if (href && !href.startsWith('#') && !isExternal(href)) throw new Error(`--single-html cannot link to another local page or file: ${href}`);
    }
    for (const attr of node.attrs) {
      if ((['src', 'poster', 'xlink:href', 'background'].includes(attr.name) && tag !== 'script') || (attr.name === 'href' && (tag === 'image' || tag === 'use'))) {
        attr.value = await localData(attr.value, base, context.root, 'asset');
      } else if (attr.name === 'srcset' || attr.name === 'imagesrcset') {
        attr.value = (await Promise.all(attr.value.split(',').map(async (entry) => {
          const match = /^(\s*)(\S+)(.*)$/.exec(entry);
          if (!match) return entry;
          return `${match[1]}${await localData(match[2], base, context.root, 'asset')}${match[3]}`;
        }))).join(',');
      } else if (attr.name === 'style') {
        attr.value = await inlineCss(`a{${attr.value}}`, base, context.root).then((css) => css.slice(2, -1));
      }
    }
    if (tag === 'style') {
      for (const child of node.childNodes) {
        if ('value' in child) child.value = await inlineCss(child.value, base, context.root);
      }
    }
  }
  if ('childNodes' in node) for (const child of node.childNodes) await inlineNode(child, base, context);
}

function isElement(node: Node): node is Element { return 'tagName' in node && 'attrs' in node; }
function getAttr(node: Element, name: string): string | undefined { return node.attrs.find((attr) => attr.name === name)?.value; }
function setAttr(node: Element, name: string, value: string): void {
  const attr = node.attrs.find((item) => item.name === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}
function isExternal(value: string): boolean { return value.startsWith('#') || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value); }

async function resolveAsset(value: string, base: string, root: string): Promise<string> {
  if (isExternal(value)) throw new Error(`--single-html cannot embed external rendering dependency: ${value}`);
  const url = new URL(value, pathToFileURL(base));
  if (url.search || url.hash || url.protocol !== 'file:') throw new Error(`--single-html cannot embed asset with query/fragment: ${value}`);
  const resolved = await fs.realpath(fileURLToPath(url)).catch(() => { throw new Error(`--single-html missing local asset: ${value}`); });
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`--single-html asset outside built site: ${value}`);
  return resolved;
}

async function localData(value: string, base: string, root: string, kind: string): Promise<string> {
  if (value.startsWith('data:') || value.startsWith('#')) return value;
  const file = await resolveAsset(value, base, root);
  if (kind === 'script' || kind === 'classic-script') {
    if (!/\.[cm]?js$/.test(file)) throw new Error(`--single-html expected JavaScript: ${value}`);
    const result = await bundleJs({ entryPoints: [file], bundle: true, write: false, format: kind === 'script' ? 'esm' : 'iife', platform: 'browser', logLevel: 'silent' });
    if (result.outputFiles.length !== 1) throw new Error(`--single-html cannot embed JavaScript with additional emitted assets: ${value}`);
    const source = result.outputFiles[0].text;
    if (/\bimport\.meta\b/.test(source) || (!file.includes(`${path.sep}_briefkit${path.sep}mermaid${path.sep}`) && /(?:^|[^.\w])(?:fetch|Worker|SharedWorker)\s*\(|\bnew\s+URL\s*\(|\bimport\s*\(/.test(source))) throw new Error(`--single-html cannot guarantee offline JavaScript asset: ${value}`);
    return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  }
  if (kind === 'css') return `data:text/css;base64,${Buffer.from(await inlineCss(await fs.readFile(file, 'utf8'), file, root)).toString('base64')}`;
  const type = mime[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`--single-html unsupported local asset type: ${value}`);
  const content = await fs.readFile(file);
  if (type === 'image/svg+xml' && /<(?:image|use|script|foreignObject|style)\b|@import\b|\b(?:href|src)\s*=\s*["'](?!#)|\burl\(\s*["']?(?!#)/i.test(content.toString('utf8'))) {
    throw new Error(`--single-html cannot guarantee offline SVG asset: ${value}`);
  }
  return `data:${type};base64,${content.toString('base64')}`;
}

async function inlineCss(source: string, base: string, root: string): Promise<string> {
  const parsed = postcss.parse(source, { from: base });
  const imports: string[] = [];
  parsed.walkAtRules('import', (rule) => { imports.push(rule.params); });
  if (imports.length) throw new Error(`--single-html does not support CSS @import: ${imports.join(', ')}`);
  const declarations: postcss.Declaration[] = [];
  parsed.walkDecls((decl) => { declarations.push(decl); });
  for (const decl of declarations) {
    const value = valueParser(decl.value);
    const urls: { node: valueParser.FunctionNode; value: string }[] = [];
    value.walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const url = node.nodes.find((part) => part.type === 'word' || part.type === 'string');
        if (url) urls.push({ node, value: url.value });
      }
    });
    for (const item of urls) {
      const data = await localData(item.value, base, root, 'asset');
      item.node.nodes = [{ type: 'string', quote: '"', value: data, sourceIndex: 0, sourceEndIndex: data.length }];
    }
    decl.value = value.toString();
  }
  return parsed.toString();
}
