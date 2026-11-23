import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

interface MockQuestion {
  dataset: { bkQuestionId: string; bkQuestionType: string; bkQuestionRequired: string };
  querySelector: (selector: string) => { value: string } | { textContent: string } | undefined;
}

function mockForm(id: string, required = true) {
  const input = { value: '' };
  const question: MockQuestion = {
    dataset: { bkQuestionId: id, bkQuestionType: 'text', bkQuestionRequired: required ? 'true' : '' },
    querySelector: (selector) => selector === 'legend' ? { textContent: id } : input,
  };
  const status = { textContent: '' };
  const button = { disabled: false };
  const handlers: Record<string, (...args: any[]) => any> = {};
  const form = {
    dataset: { bkResponseId: id, ...(id === 'second' ? { bkResponseAction: 'https://hooks.example.test/respond' } : {}) },
    querySelector: (selector: string) => selector === '.bk-response-status' ? status : button,
    querySelectorAll: (selector: string) => selector === '[data-bk-question-id]' ? [question]
      : selector === 'input, select, textarea, button' ? [input, button] : [],
    addEventListener: (type: string, callback: (...args: any[]) => any) => { handlers[type] = callback; },
    reportValidity: () => true,
  };
  return { form, input, status, button, handlers };
}

function meta(html: string, name: string): string | undefined {
  const encoded = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
  return encoded?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

function runPage(script: string, html: string, url: string, form: ReturnType<typeof mockForm>,
  storage: Map<string, string>, pages: Map<string, string>, posts: any[], remoteId = 'first') {
  class HTMLFormElement {}
  Object.setPrototypeOf(form.form, HTMLFormElement.prototype);
  const page = (source: string, pageForm: ReturnType<typeof mockForm>) => ({
    querySelector: (selector: string) => {
      const name = selector.match(/meta\[name="([^"]+)"\]/)?.[1];
      const content = name && meta(source, name);
      return content === undefined ? undefined : { content };
    },
    querySelectorAll: (selector: string) => selector === '[data-bk-response-form]' ? [pageForm.form] : [],
  });
  const doc = page(html, form);
  const fetchCalls: string[] = [];
  runInNewContext(script, {
    HTMLFormElement,
    document: { ...doc, readyState: 'complete' },
    window: { location: { href: url } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    DOMParser: class {
      parseFromString(source: string) {
        const remote = mockForm(remoteId);
        if (remoteId === 'second') remote.input.value = 'existing answer';
        return page(source, remote);
      }
    },
    URL,
    navigator: { clipboard: { writeText: async (value: string) => posts.push(JSON.parse(value)) } },
    fetch: async (target: string, options?: { body: string }) => {
      fetchCalls.push(target);
      if (options?.body) {
        posts.push(JSON.parse(options.body));
        return { ok: true, status: 201, json: async () => ({ accepted: true }) };
      }
      return { ok: pages.has(target), status: pages.has(target) ? 200 : 404, text: async () => pages.get(target) || '' };
    },
  });
  return fetchCalls;
}

test('build renders cross-page response manifest and submits one combined answer after navigation', { timeout: 120_000 }, async () => {
  const report = await makeTempDir('response-aggregation');
  await fs.mkdir(path.join(report, 'pages'));
  await fs.writeFile(path.join(report, 'index.mdx'), `# First\n\nimport { UserRespond } from 'briefkit';\n\n<UserRespond id="first" questions={[{ id: 'first', type: 'text', label: 'First', required: true }]} />\n`);
  await fs.writeFile(path.join(report, 'pages', 'second.mdx'), `# Second\n\nimport { UserRespond } from 'briefkit';\n\n<UserRespond id="second" action="https://hooks.example.test/respond" questions={[{ id: 'second', type: 'text', label: 'Second', required: true }]} />\n`);
  const out = path.join(report, 'out');
  const build = await runBriefkit(['build', report, '--out', out]);
  assert.equal(build.exitCode, 0, build.stderr);
  const firstHtml = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  const secondHtml = await fs.readFile(path.join(out, 'second', 'index.html'), 'utf8');
  assert.equal(meta(firstHtml, 'briefkit-response-version'), meta(secondHtml, 'briefkit-response-version'));
  assert.deepEqual(JSON.parse(meta(firstHtml, 'briefkit-response-pages') || '[]'), ['./', 'second/']);
  assert.deepEqual(JSON.parse(meta(secondHtml, 'briefkit-response-pages') || '[]'), ['../', './']);
  const script = [...secondHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] || '').find((source) => source.includes('__briefkitResponseReady'));
  assert(script);
  const origin = 'https://brief.example.test/report/';
  const pages = new Map([[origin, firstHtml], [`${origin}second/`, secondHtml]]);
  const storage = new Map<string, string>();
  const posts: any[] = [];
  const first = mockForm('first');
  runPage(script, firstHtml, `${origin}?ref=review`, first, storage, pages, posts);
  const missing = mockForm('second');
  runPage(script, secondHtml, `${origin}second/`, missing, storage, pages, posts);
  missing.input.value = 'answer from second page';
  await missing.handlers.submit({ preventDefault() {} });
  assert.match(missing.status.textContent, /Answer required: first/);
  assert.equal(posts.length, 0);

  first.input.value = 'answer from first page';
  first.handlers.input();
  const second = mockForm('second');
  const fetchCalls = runPage(script, secondHtml, `${origin}second/`, second, storage, pages, posts);
  second.input.value = 'answer from second page';
  await second.handlers.submit({ preventDefault() {} });
  assert.match(second.status.textContent, /submitted/);
  assert.deepEqual(posts[0].answers, { first: 'answer from first page', second: 'answer from second page' });
  assert.equal(posts[0].formId, 'brief');
  assert.deepEqual(fetchCalls, [origin, 'https://hooks.example.test/respond']);
  assert.equal(storage.size, 0);

  const conflicting = mockForm('second');
  runPage(script, secondHtml, `${origin}second/`, conflicting, storage, pages, posts, 'second');
  conflicting.input.value = 'another answer';
  await conflicting.handlers.submit({ preventDefault() {} });
  assert.match(conflicting.status.textContent, /Question id "second" is used more than once/);
  assert.equal(posts.length, 1);

  await fs.appendFile(path.join(report, 'index.mdx'), '\nChanged brief source.\n');
  const rebuild = await runBriefkit(['build', report, '--out', out]);
  assert.equal(rebuild.exitCode, 0, rebuild.stderr);
  const revisedHtml = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  assert.notEqual(meta(revisedHtml, 'briefkit-response-version'), meta(firstHtml, 'briefkit-response-version'));
});
