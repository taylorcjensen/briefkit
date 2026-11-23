import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

async function report(source: string): Promise<string> {
  const dir = await makeTempDir('diagnostics');
  await fs.writeFile(path.join(dir, 'index.mdx'), source);
  return dir;
}

test('check warns with source locations, ignores fenced and inline examples, and leaves no build output', async () => {
  const dir = await report(`# Overview

[good](#overview) [bad](#absent) [file](./missing.csv) [web](https://example.com/a)

![missing](/missing.png) [^lost] TODO

\`[not a link](./fake.csv) TODO\`

\`\`\`md
[not a link](./fenced.csv) [^fenced] TODO
\`\`\`
`);
  const result = await runBriefkit(['check', dir]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /index\.mdx:3: Missing anchor #absent/);
  assert.match(result.stderr, /index\.mdx:3: Missing local asset or page: .\/missing\.csv/);
  assert.match(result.stderr, /index\.mdx:5: Missing local asset or page: \/missing\.png/);
  assert.match(result.stderr, /index\.mdx:5: Undefined footnote \[\^lost\]/);
  assert.match(result.stderr, /index\.mdx:5: Placeholder TODO/);
  assert.doesNotMatch(result.stderr, /fake|fenced|example\.com/);
  await assert.rejects(fs.access(path.join(dir, 'brief')));
});

test('build emits the same warnings without making them fatal; compiler errors remain fatal', async () => {
  const dir = await report('# Report\n\n[missing](#oops)\n');
  const output = path.join(dir, 'site');
  const checked = await runBriefkit(['check', dir]);
  const built = await runBriefkit(['build', dir, '--out', output]);
  assert.equal(built.exitCode, 0, built.stderr);
  assert.match(built.stderr, /index\.mdx:3: Missing anchor #oops/);
  assert.equal(built.stderr.match(/index\.mdx:3: Missing anchor #oops/)?.[0], checked.stderr.match(/index\.mdx:3: Missing anchor #oops/)?.[0]);
  await fs.access(path.join(output, 'index.html'));
  await fs.writeFile(path.join(dir, 'index.mdx'), '# Broken\n\n<BadComponent />\n');
  const broken = await runBriefkit(['build', dir, '--out', output]);
  assert.notEqual(broken.exitCode, 0);
  assert.match(broken.stderr, /BadComponent/);
});

test('route and explicit anchors resolve across pages; duplicate headings get numbered slugs', async () => {
  const dir = await report('# Home\n\n[other](./pages/other.md#second-1) [route](/other/#custom)\n');
  await fs.mkdir(path.join(dir, 'pages'));
  await fs.writeFile(path.join(dir, 'pages', 'other.md'), '# Second\n\n## Second\n\n<h2 id="custom">Named</h2>\n');
  const checked = await runBriefkit(['check', dir]);
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.doesNotMatch(checked.stderr, /warning/);
});

test('check reports missing @report/data imports outside code fences', async () => {
  const dir = await report("import rows from '@report/data/rows.yaml';\n\n# Report\n\n```mdx\nimport example from '@report/data/example.yaml';\n```\n");
  const checked = await runBriefkit(['check', dir]);
  assert.equal(checked.exitCode, 0);
  assert.match(checked.stderr, /index\.mdx:1: Missing referenced data: data\/rows\.yaml/);
  assert.doesNotMatch(checked.stderr, /example\.yaml/);
});
