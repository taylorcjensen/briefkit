import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  classifyUrlReference,
  normalizePortableAssetUrls,
  rewriteCssRootUrls,
  rewriteReportRootUrl,
  rewriteSrcset,
} from '../src/lib/portableAssetUrls.ts';
import { makeTempDir } from './helpers/process.ts';

test('classifies report-root references without rewriting external or special URLs', () => {
  assert.equal(classifyUrlReference('/chart.png'), 'report-root');
  assert.equal(classifyUrlReference('/docs/file.pdf?download=1#page=2'), 'report-root');
  assert.equal(classifyUrlReference('//cdn.example.com/app.js'), 'external-or-special');
  assert.equal(classifyUrlReference('https://example.com/chart.png'), 'external-or-special');
  assert.equal(classifyUrlReference('mailto:test@example.com'), 'external-or-special');
  assert.equal(classifyUrlReference('data:image/png;base64,abc'), 'external-or-special');
  assert.equal(classifyUrlReference('blob:https://example.com/id'), 'external-or-special');
  assert.equal(classifyUrlReference('#section'), 'external-or-special');
  assert.equal(classifyUrlReference('./chart.png'), 'relative');
  assert.equal(classifyUrlReference('../chart.png'), 'relative');
  assert.equal(classifyUrlReference('chart.png'), 'relative');
});

test('rewrites report-root URLs to the supplied relative prefix and preserves suffixes', () => {
  assert.equal(rewriteReportRootUrl('/chart.png', './'), './chart.png');
  assert.equal(rewriteReportRootUrl('/docs/file.pdf?download=1#page=2', '../'), '../docs/file.pdf?download=1#page=2');
  assert.equal(rewriteReportRootUrl('  /chart.png', '../'), '  ../chart.png');
  assert.equal(rewriteReportRootUrl('//cdn.example.com/chart.png', '../'), '//cdn.example.com/chart.png');
  assert.equal(rewriteReportRootUrl('assets/chart.png', '../'), 'assets/chart.png');
});

test('rewrites only report-root srcset candidates', () => {
  assert.equal(
    rewriteSrcset('/small.png 480w, /large.png 960w, https://cdn.example.com/x.png 2x, ../kept.png 3x', '../'),
    '../small.png 480w, ../large.png 960w, https://cdn.example.com/x.png 2x, ../kept.png 3x',
  );
});

test('rewrites srcset without splitting data URL candidates on commas', () => {
  assert.equal(
    rewriteSrcset('data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, /chart.png 2x', '../'),
    'data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, ../chart.png 2x',
  );
  assert.equal(
    rewriteSrcset('data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, /fallback.png 2x', './'),
    'data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, ./fallback.png 2x',
  );
});

test('rewrites CSS url() and @import report-root references', () => {
  const css = '@import "/theme.css" screen; @import url(/print.css); .hero{background:url("/hero.png?v=1#hash")} .icon{mask:url(data:image/svg+xml,abc)} .cursor{cursor:url(../cursor.cur), auto}';

  assert.equal(
    rewriteCssRootUrls(css, '../'),
    '@import "../theme.css" screen; @import url(../print.css); .hero{background:url("../hero.png?v=1#hash")} .icon{mask:url(data:image/svg+xml,abc)} .cursor{cursor:url(../cursor.cur), auto}',
  );
});

test('normalizer preserves multiple inline style declarations and semicolons', async () => {
  const outDir = await makeTempDir('portable-inline-style');
  const htmlPath = path.join(outDir, 'index.html');
  await fs.writeFile(htmlPath, '<!doctype html><html><body><div style="background:url(/a.png); color: red; mask: url(/b.svg);"></div></body></html>', 'utf8');

  await normalizePortableAssetUrls(outDir);

  const html = await fs.readFile(htmlPath, 'utf8');
  assert.match(html, /style="background:url\(\.\/a\.png\);\s*color: red;\s*mask: url\(\.\/b\.svg\);?"/);
});

test('normalizer preserves HTML fragments instead of wrapping them as documents', async () => {
  const outDir = await makeTempDir('portable-fragment');
  const fragmentPath = path.join(outDir, 'fragment.html');
  await fs.writeFile(fragmentPath, '<img src="/chart.png"><a href="/docs/file.pdf">PDF</a>', 'utf8');

  await normalizePortableAssetUrls(outDir);

  assert.equal(await fs.readFile(fragmentPath, 'utf8'), '<img src="./chart.png"><a href="./docs/file.pdf">PDF</a>');
});

test('normalizer preserves malformed CSS and warns instead of throwing', async () => {
  const outDir = await makeTempDir('portable-malformed-css');
  const cssPath = path.join(outDir, 'bad.css');
  const htmlPath = path.join(outDir, 'index.html');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  await fs.writeFile(cssPath, '.bad{color:', 'utf8');
  await fs.writeFile(htmlPath, '<!doctype html><html><head><style>.bad{color:</style></head><body><div style="color:red}"></div></body></html>', 'utf8');

  try {
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    await normalizePortableAssetUrls(outDir);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(await fs.readFile(cssPath, 'utf8'), '.bad{color:');
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.match(html, /<style>\.bad\{color:<\/style>/);
  assert.match(html, /style="color:red}"/);
  assert(warnings.some((warning) => warning.includes('bad.css')));
  assert(warnings.some((warning) => warning.includes('<style>')));
  assert(warnings.some((warning) => warning.includes('style attribute')));
});
