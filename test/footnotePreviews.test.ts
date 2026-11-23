import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'parse5';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

type HtmlNode = { tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: HtmlNode[]; value?: string };

function nodes(root: HtmlNode): HtmlNode[] {
  return [root, ...(root.childNodes ?? []).flatMap(nodes)];
}
function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name === name)?.value;
}

for (const extension of ['md', 'mdx']) {
  test(`${extension} footnotes keep navigation and include the preview enhancer`, async () => {
    const reportDir = await makeTempDir(`footnote-${extension}-`);
    const outDir = path.join(reportDir, 'out');
    await fs.writeFile(path.join(reportDir, `index.${extension}`), `First[^study] and repeated[^study].

[^study]: The [study](https://example.com/study) has **details** and <span id="author-anchor">an anchor</span>.
`, 'utf8');

    const result = await runBriefkit(['build', reportDir, '--out', outDir, '--no-open']);
    assert.equal(result.exitCode, 0, result.stderr);
    const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const elements = nodes(parse(html) as HtmlNode);
    const refs = elements.filter((node) => attr(node, 'data-footnote-ref') !== undefined);
    const backrefs = elements.filter((node) => attr(node, 'data-footnote-backref') !== undefined);
    const definition = elements.find((node) => attr(node, 'id') === 'user-content-fn-study');
    const ids = elements.map((node) => attr(node, 'id')).filter(Boolean);
    const runtime = elements.filter((node) => node.tagName === 'script').map((node) => node.childNodes?.map((child) => child.value ?? '').join('') ?? '').join('\n');

    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((node) => attr(node, 'href')), ['#user-content-fn-study', '#user-content-fn-study']);
    assert.notEqual(attr(refs[0], 'id'), attr(refs[1], 'id'));
    assert.equal(backrefs.length, 2);
    assert.equal(definition?.tagName, 'li');
    assert(ids.includes('author-anchor'));
    assert.equal(ids.length, new Set(ids).size, 'static HTML must have unique IDs');
    assert.match(html, /href="https:\/\/example\.com\/study"/);
    assert.match(html, /bk-footnote-tooltip/);
    assert.match(runtime, /initFootnotePreviews\(\)/);
    assert.match(runtime, /cloneNode\(true\)/);
  });
}
