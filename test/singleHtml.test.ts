import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

async function report(source: string): Promise<{ dir: string; out: string }> {
  const parent = await makeTempDir('single-html');
  const dir = path.join(parent, 'report');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'index.mdx'), source);
  return { dir, out: path.join(parent, 'brief.html') };
}

test('single HTML embeds local images, stylesheet and script and can be rebuilt only while owned', async () => {
  const { dir, out } = await report('---\ntitle: Offline\n---\n\n<div style={{backgroundImage: "url(/chart.png)"}}>Color</div>\n\n![chart](/chart.png)\n\n## Decision\n\nText.');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public', 'chart.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
  const args = ['build', dir, '--single-html', '--out', out];
  const first = await runBriefkit(args);
  assert.equal(first.exitCode, 0, first.stderr);
  const html = await fs.readFile(out, 'utf8');
  assert.match(html, /src="data:image\/png;base64,/);
  assert.match(html, /background-image:[^>]+data:image\/png;base64,/);
  assert.match(html, /<style/);
  assert.match(html, /data-bk-theme-button/);
  assert.doesNotMatch(html, /(?:src|href)="(?:\.\/|\.\.\/|\/)_(?:astro|briefkit)/);
  assert.equal((await runBriefkit(args)).exitCode, 0);
  await fs.appendFile(out, '\nuser change');
  const refused = await runBriefkit(args);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /modified or unowned HTML/);
  assert.match(await fs.readFile(out, 'utf8'), /user change/);
});

test('single HTML rejects multi-page reports and unowned destinations before replacing them', async () => {
  const { dir, out } = await report('# Single\n');
  await fs.writeFile(out, 'user file');
  const refused = await runBriefkit(['build', dir, '--single-html', '--out', out]);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /without Briefkit ownership marker/);
  assert.equal(await fs.readFile(out, 'utf8'), 'user file');
  await fs.mkdir(path.join(dir, 'pages'));
  await fs.writeFile(path.join(dir, 'pages', 'second.md'), '# Second\n');
  const multi = await runBriefkit(['build', dir, '--single-html', '--out', path.join(path.dirname(out), 'new.html')]);
  assert.notEqual(multi.exitCode, 0);
  assert.match(multi.stderr, /exactly one visible page/);
});

test('single HTML bundles emitted client scripts and rejects external rendering sources', async () => {
  const { dir, out } = await report('---\ntitle: Client\n---\n\n<script src="/chart.js" type="module"></script>\n\n## Chart\n');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public', 'chart.js'), 'document.body.dataset.chart = "ready";');
  const built = await runBriefkit(['build', dir, '--single-html', '--out', out]);
  assert.equal(built.exitCode, 0, built.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /src="data:text\/javascript;base64,/);
  await fs.writeFile(path.join(dir, 'index.mdx'), '![remote](https://example.com/chart.png)');
  const rejected = await runBriefkit(['build', dir, '--single-html', '--out', out]);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /external rendering dependency/);
  assert.match(await fs.readFile(out, 'utf8'), /data:text\/javascript;base64/);
});

test('single HTML includes Mermaid runtime as data module, never a local module path', async () => {
  const { dir, out } = await report('# Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```\n');
  const result = await runBriefkit(['build', dir, '--single-html', '--out', out]);
  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(out, 'utf8');
  assert.match(html, /mermaidUrl = .*data:text\/javascript;base64,/);
  assert.match(html, /data-bk-mermaid-source/);
  assert.doesNotMatch(html, /data-bk-mermaid-url="(?:\.\/|\/)/);
});
