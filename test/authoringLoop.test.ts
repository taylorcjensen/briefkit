import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');

async function makeReportDir(prefix: string): Promise<string> {
  const tempDir = await makeTempDir(prefix);
  const reportDir = path.join(tempDir, 'report');
  await fs.mkdir(reportDir, { recursive: true });
  return reportDir;
}

test('page preprocessing preserves slashes in prose while retaining table colgroup injection', async () => {
  const reportDir = await makeReportDir('slash-preserve');
  const outDir = path.join(path.dirname(reportDir), 'out');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Slash Report
---
# Slash Report

Bare URL: https://example.com/a/b?x=1.

Filesystem path: /Users/tcj/Code/briefkit/src/lib/workspace.ts

Ratio: 16/9 and 1/2 scale.

Variant: A/B test copy.

<table><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody><tr><td>A/B</td><td>16/9</td></tr></tbody></table>
`, 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir]);

  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /https:\/\/example\.com\/a\/b\?x=1/);
  assert.match(html, /\/Users\/tcj\/Code\/briefkit\/src\/lib\/workspace\.ts/);
  assert.match(html, /16\/9/);
  assert.match(html, /A\/B test copy/);
  assert.match(html, /<colgroup>/);
  assert.doesNotMatch(html, /https: \/ \/example\.com/);
  assert.doesNotMatch(html, /A \/ B test copy/);
});

test('fenced MDX import examples remain literal and do not leak absolute paths', async () => {
  const reportDir = await makeReportDir('fenced-imports');
  const outDir = path.join(path.dirname(reportDir), 'out');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Import Examples
---
# Import Examples

\`\`\`mdx
import Thing from './components/Thing.astro';
export { value } from '../data/value.js';
\`\`\`
`, 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir]);

  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /import Thing from &#39;\.\/components\/Thing\.astro&#39;;/);
  assert.match(html, /export \{ value \} from &#39;\.\.\/data\/value\.js&#39;;/);
  assert.doesNotMatch(html, new RegExp(escapeRegExp(reportDir)));
});

test('TOC hrefs resolve to Astro-rendered heading IDs and ignore fenced heading examples', async () => {
  const reportDir = await makeReportDir('toc-ids');
  const outDir = path.join(path.dirname(reportDir), 'out');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: TOC Report
---
# TOC Report

## Café déjà vu!

## Café déjà vu!

## Punctuation: A/B & C?

<h2 id="manual-anchor">Explicit ID</h2>

## With \`code\` and [link](https://example.com/a/b)

\`\`\`mdx
## Fenced Markdown Heading
<h2 id="fenced-html-heading">Fenced HTML Heading</h2>
\`\`\`

~~~html
<h3 id="fenced-tilde-heading">Fenced Tilde Heading</h3>
~~~

   \`\`\`mdx
   ## Indented Fenced Markdown Heading
   <h2 id="indented-fenced-html-heading">Indented Fenced HTML Heading</h2>
   \`\`\`\`

   ## Indented Real Heading

### Nested depth

#### Deep depth

##### Excluded depth
`, 'utf8');

  const result = await runBriefkit(['build', reportDir, '--out', outDir]);

  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  const headingIds = new Set([...html.matchAll(/<h[2-4]\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]));
  const tocHrefs = [...html.matchAll(/<a href="#([^"]+)">/g)].map((match) => match[1]);

  assert(tocHrefs.length >= 8, `Expected TOC hrefs in built HTML. HTML: ${html}`);
  assert(tocHrefs.includes('manual-anchor'));
  assert(!tocHrefs.some((href) => href.includes('excluded')));
  assert(!tocHrefs.some((href) => href.includes('fenced')));
  assert(tocHrefs.includes('indented-real-heading'));
  for (const href of tocHrefs) {
    assert(headingIds.has(href), `TOC href #${href} did not resolve to a rendered heading ID. IDs: ${[...headingIds].join(', ')}`);
  }
});

test('dev server resyncs changed pages, config, added and removed pages, public assets, and imported components without deleting workspace internals', async (t) => {
  const reportDir = await makeReportDir('dev-sync');
  const componentsDir = path.join(reportDir, 'components');
  const pagesDir = path.join(reportDir, 'pages');
  const publicDir = path.join(reportDir, 'public');
  await fs.mkdir(componentsDir, { recursive: true });
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(componentsDir, 'Badge.astro'), '<span>Badge v1</span>\n', 'utf8');
  await fs.writeFile(path.join(publicDir, 'asset.txt'), 'asset v1', 'utf8');
  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { title: 'Dev Sync v1' };\n`, 'utf8');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Home v1
---
import Badge from '@report/components/Badge.astro';

<Badge />

## Initial Heading

Initial body.
`, 'utf8');
  await fs.writeFile(path.join(pagesDir, 'hidden.mdx'), `---
title: Hidden
hidden: true
---

Hidden page.
`, 'utf8');

  const port = await reservePort();
  const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(packageRoot, 'bin', 'briefkit.js'), 'dev', reportDir, '--port', String(port), '--no-open'], {
    cwd: packageRoot,
    env: { ...process.env, BRIEFKIT_TSX_RUN: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => stopProcess(child));

  const { url, stdout } = await waitForDevServer(child);
  const workspaceDir = workspaceDirForPort(reportDir, port);
  assert.equal(/Report: (.+)/.exec(stdout)?.[1], reportDir);
  await fs.access(path.join(workspaceDir, 'node_modules'));
  await fs.access(path.join(workspaceDir, 'astro.config.mjs'));

  assert.match(await fetchText(url), /Initial body/);
  assert.equal(await fetchText(`${url}/asset.txt`), 'asset v1');

  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Broken Custom Layout
layout: custom
---

Broken body should not replace the last good workspace.
`, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(await fetchText(url), /Initial body/);
  await fs.access(path.join(workspaceDir, 'node_modules'));
  await fs.access(path.join(workspaceDir, 'astro.config.mjs'));
  await fs.access(path.join(workspaceDir, 'src', 'processed', 'index.mdx'));

  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Home v2
---
import Badge from '@report/components/Badge.astro';

<Badge />

## Changed Heading

Changed body.
`, 'utf8');
  await eventually(async () => assert.match(await fetchText(url), /Changed body/));

  await fs.writeFile(path.join(componentsDir, 'Badge.astro'), '<span>Badge v2</span>\n', 'utf8');
  await eventually(async () => assert.match(await fetchText(url), /Badge v2/));

  await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), `export default { title: 'Dev Sync v2', pages: [{ file: 'index.mdx', title: 'Home v2' }, { file: 'pages/hidden.mdx', title: 'Shown', route: '/shown/' }] };\n`, 'utf8');
  await fs.writeFile(path.join(pagesDir, 'hidden.mdx'), `---
title: Shown
hidden: false
---

Shown body.
`, 'utf8');
  await eventually(async () => assert.match(await fetchText(`${url}/shown/`), /Shown body/));
  await eventually(async () => assert.match(await fetchText(url), /Dev Sync v2/));

  await fs.writeFile(path.join(pagesDir, 'added.mdx'), `---
title: Added
---

Added body.
`, 'utf8');
  await eventually(async () => assert.match(await fetchText(`${url}/added/`), /Added body/));

  await fs.rm(path.join(pagesDir, 'added.mdx'));
  await eventually(async () => {
    const response = await fetch(`${url}/added/`);
    assert.equal(response.status, 404);
  });

  await fs.writeFile(path.join(publicDir, 'asset.txt'), 'asset v2', 'utf8');
  await eventually(async () => assert.equal(await fetchText(`${url}/asset.txt`), 'asset v2'));
  await fs.access(path.join(workspaceDir, 'node_modules'));
  await fs.access(path.join(workspaceDir, 'astro.config.mjs'));
});

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForDevServer(child: ChildProcessWithoutNullStreams): Promise<{ url: string; stdout: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  await eventually(async () => {
    assert.equal(child.exitCode, null, `Dev server exited early.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /URL: http:\/\/localhost:\d+/);
  }, { timeoutMs: 20000 });

  const url = /URL: (http:\/\/localhost:\d+)/.exec(stdout)?.[1];
  assert(url, stdout);
  return { url, stdout };
}

function workspaceDirForPort(reportDir: string, port: number): string {
  const slug = path.basename(reportDir).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'report';
  const hash = crypto.createHash('sha1').update(reportDir).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'briefkit', `${slug}-${hash}-${port}`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, `${url} returned HTTP ${response.status}: ${text}`);
  return text;
}

async function eventually(assertion: () => Promise<void> | void, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 200;
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
