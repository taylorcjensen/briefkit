import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeBasicReport, makeTempDir, runBriefkit } from './helpers/process.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');
const apiKey = 'test-key';
const serverProcesses = new Set<ChildProcessWithoutNullStreams>();

interface PublishServer {
  origin: string;
  storageDir: string;
  stop: () => Promise<void>;
}

interface HttpResult {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

after(async () => {
  await Promise.all([...serverProcesses].map((serverProcess) => stopProcess(serverProcess)));
});

test('publish API rejects unauthorized and malformed requests without public storage mutation', async () => {
  const server = await startPublishServer('reject-basic');
  try {
    const unauthorized = await postJson(server.origin, { title: 'Secret', files: [textFile('index.html', 'secret')] }, undefined);
    assert.equal(unauthorized.status, 401);

    const malformed = await postRaw(server.origin, '{not json', apiKey);
    assert.equal(malformed.status, 400);

    const nonObject = await postRaw(server.origin, '[]', apiKey);
    assert.equal(nonObject.status, 400);

    assert.deepEqual(await publicStorageEntries(server.storageDir), []);
  } finally {
    await server.stop();
  }
});

test('publish API strictly validates files before creating public briefs', async () => {
  const server = await startPublishServer('reject-files');
  const invalidPayloads = [
    { title: 'Invalid Base64', files: [{ path: 'index.html', contentBase64: 'not base64' }] },
    { title: 'Duplicate Paths', files: [textFile('index.html', 'one'), textFile('index.html', 'two')] },
    { title: 'Path Conflict', files: [textFile('assets', 'file'), textFile('assets/app.js', 'script')] },
    { title: 'Traversal', files: [textFile('../index.html', 'bad')] },
    { title: 'Absolute Path', files: [textFile('/index.html', 'bad')] },
    { title: 'Trailing Slash', files: [textFile('assets/', 'bad')] },
    { title: 'Empty Segment', files: [textFile('assets//app.js', 'bad')] },
    { title: 'Reserved Metadata', files: [textFile('.briefkit.json', 'bad')] },
    { title: 'Reserved Staging', files: [textFile('.briefkit-staging-x/index.html', 'bad')] },
    { title: 'Later Invalid', files: [textFile('index.html', 'would be partial'), { path: 'assets/app.js', contentBase64: 'bad!' }] },
  ];

  try {
    for (const payload of invalidPayloads) {
      const result = await postJson(server.origin, payload, apiKey);
      assert.equal(result.status, 400, `${payload.title}: ${result.text}`);
      assert.deepEqual(await publicStorageEntries(server.storageDir), [], payload.title);
    }
  } finally {
    await server.stop();
  }
});

test('publish API accepts empty file contents and publishes through direct access', async () => {
  const server = await startPublishServer('empty-file');
  try {
    const result = await postJson(server.origin, { title: 'Empty File', files: [{ path: 'index.html', contentBase64: '' }] }, apiKey);
    assert.equal(result.status, 201, result.text);
    assert.equal(result.json.slug, 'empty-file');

    const response = await fetch(`${server.origin}/empty-file/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  } finally {
    await server.stop();
  }
});

test('concurrent same-title publishes get distinct complete briefs without mixed files', async () => {
  const server = await startPublishServer('concurrent');
  try {
    const requests = Array.from({ length: 6 }, (_unused, index) => ({
      title: 'Same Title',
      files: [textFile('index.html', `brief ${index}`), textFile('assets/data.txt', `asset ${index}`)],
    }));

    const results = await Promise.all(requests.map((payload) => postJson(server.origin, payload, apiKey)));
    assert(results.every((result) => result.status === 201), results.map((result) => result.text).join('\n'));
    const slugs = results.map((result) => result.json.slug as string);
    assert.equal(new Set(slugs).size, requests.length);

    for (const [index, slug] of slugs.entries()) {
      const indexResponse = await fetch(`${server.origin}/${slug}/`);
      const assetResponse = await fetch(`${server.origin}/${slug}/assets/data.txt`);
      assert.equal(indexResponse.status, 200);
      assert.equal(assetResponse.status, 200);
      assert.equal(await indexResponse.text(), `brief ${index}`);
      assert.equal(await assetResponse.text(), `asset ${index}`);
    }
  } finally {
    await server.stop();
  }
});

test('static serving hides internal paths, excludes unindexed briefs, and cleans only stale staging on startup', async () => {
  const storageDir = await makeTempDir('server-storage-internal');
  const staleStaging = path.join(storageDir, '.briefkit-staging-old');
  const staleLock = path.join(storageDir, '.briefkit-lock-old');
  const activeStaging = path.join(storageDir, '.briefkit-staging-active');
  await fs.mkdir(staleStaging, { recursive: true });
  await fs.mkdir(staleLock, { recursive: true });
  await fs.mkdir(activeStaging, { recursive: true });
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(staleStaging, oldDate, oldDate);
  await fs.utimes(staleLock, oldDate, oldDate);
  const server = await startPublishServer('internal', storageDir, { BRIEFKIT_INTERNAL_CLEANUP_STALE_MS: '1000' });
  try {
    await assert.rejects(fs.access(staleStaging));
    await assert.rejects(fs.access(staleLock));
    await fs.access(activeStaging);

    const indexed = await postJson(server.origin, { title: 'Indexed Brief', indexed: true, files: [textFile('index.html', 'indexed')] }, apiKey);
    const unindexed = await postJson(server.origin, { title: 'Private Brief', indexed: false, files: [textFile('index.html', 'private')] }, apiKey);
    assert.equal(indexed.status, 201, indexed.text);
    assert.equal(unindexed.status, 201, unindexed.text);

    const indexHtml = await (await fetch(`${server.origin}/`)).text();
    assert.match(indexHtml, /Indexed Brief/);
    assert.doesNotMatch(indexHtml, /Private Brief/);

    const privateResponse = await fetch(`${server.origin}/${unindexed.json.slug}/`);
    assert.equal(privateResponse.status, 200);
    assert.equal(await privateResponse.text(), 'private');

    assert.equal((await fetch(`${server.origin}/${indexed.json.slug}/.briefkit.json`)).status, 404);
    assert.equal((await fetch(`${server.origin}/.briefkit-staging-old/index.html`)).status, 404);
  } finally {
    await server.stop();
  }
});

test('response channels separate submit and wait credentials and accept one response', async () => {
  const server = await startPublishServer('response-channel');
  const responseBody = {
    schemaVersion: 1,
    formId: 'deployment',
    answers: { approved: true, strategy: 'rolling', targets: ['web', 'worker'] },
    submittedAt: '2026-09-13T12:00:00.000Z',
    pageUrl: `${server.origin}/deployment/`,
  };

  try {
    const unauthorizedCreate = await fetch(`${server.origin}/api/response-channels`, { method: 'POST', body: '{}' });
    assert.equal(unauthorizedCreate.status, 401);

    const createResponse = await fetch(`${server.origin}/api/response-channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const createText = await createResponse.text();
    assert.equal(createResponse.status, 201, createText);
    const channel = JSON.parse(createText) as {
      id: string;
      submitUrl: string;
      submitToken: string;
      waitUrl: string;
      waitToken: string;
      expiresAt: string;
    };
    assert.match(channel.id, /^[a-f0-9]{32}$/);
    assert.notEqual(channel.submitToken, channel.waitToken);

    const unauthorizedWait = await fetch(channel.waitUrl, {
      headers: { authorization: `Bearer ${channel.submitToken}` },
    });
    assert.equal(unauthorizedWait.status, 401);

    const malformedSubmission = await fetch(channel.submitUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${channel.submitToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    });
    assert.equal(malformedSubmission.status, 400);

    const accepted = await fetch(channel.submitUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${channel.submitToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(responseBody),
    });
    assert.equal(accepted.status, 201, await accepted.text());

    const duplicate = await fetch(channel.submitUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${channel.submitToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(responseBody),
    });
    assert.equal(duplicate.status, 409);

    const waitResponse = await fetch(channel.waitUrl, {
      headers: { authorization: `Bearer ${channel.waitToken}` },
    });
    const waitText = await waitResponse.text();
    assert.equal(waitResponse.status, 200, waitText);
    assert.deepEqual(JSON.parse(waitText), responseBody);

    const deleted = await fetch(channel.waitUrl, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${channel.waitToken}` },
    });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(channel.waitUrl, { headers: { authorization: `Bearer ${channel.waitToken}` } })).status, 404);
  } finally {
    await server.stop();
  }
});

test('expired response channels are rejected and removed', async () => {
  const server = await startPublishServer('response-expired', undefined, { BRIEFKIT_RESPONSE_DURATION: '0d' });
  try {
    const createResponse = await fetch(`${server.origin}/api/response-channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(createResponse.status, 201);
    const channel = await createResponse.json() as { waitUrl: string; waitToken: string };
    const expired = await fetch(channel.waitUrl, { headers: { authorization: `Bearer ${channel.waitToken}` } });
    assert.equal(expired.status, 410);
  } finally {
    await server.stop();
  }
});

test('response channels reject submissions that finish after expiry', async () => {
  const server = await startPublishServer('response-expires-during-submit');
  try {
    const createResponse = await fetch(`${server.origin}/api/response-channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(createResponse.status, 201);
    const channel = await createResponse.json() as { id: string; submitUrl: string; submitToken: string };
    const channelDir = path.join(server.storageDir, '.briefkit-responses', channel.id);
    const channelPath = path.join(channelDir, 'channel.json');
    const channelMetadata = JSON.parse(await fs.readFile(channelPath, 'utf8')) as Record<string, unknown>;
    channelMetadata.expiresAt = new Date(Date.now() + 200).toISOString();
    await fs.writeFile(channelPath, JSON.stringify(channelMetadata), 'utf8');

    const responseBody = JSON.stringify({
      schemaVersion: 1,
      formId: 'slow-response',
      answers: { approved: true },
      submittedAt: '2026-09-13T12:00:00.000Z',
      pageUrl: `${server.origin}/slow-response/`,
    });
    const result = await postBodyAfterDelay(channel.submitUrl, responseBody, channel.submitToken, 300);

    assert.equal(result.status, 410, result.text);
    await assert.rejects(fs.access(path.join(channelDir, 'response.json')));
  } finally {
    await server.stop();
  }
});

test('response channels reject submissions above the configured size limit', async () => {
  const server = await startPublishServer('response-size', undefined, { BRIEFKIT_MAX_RESPONSE_BYTES: '128' });
  try {
    const createResponse = await fetch(`${server.origin}/api/response-channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const channel = await createResponse.json() as { submitUrl: string; submitToken: string };
    const oversized = await fetch(channel.submitUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${channel.submitToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        formId: 'oversized',
        answers: { notes: 'x'.repeat(256) },
        submittedAt: '2026-09-13T12:00:00.000Z',
        pageUrl: `${server.origin}/oversized/`,
      }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.stop();
  }
});

test('DELETE rejects malformed percent-encoded slugs with 400', async () => {
  const server = await startPublishServer('bad-delete');
  try {
    const response = await fetch(`${server.origin}/api/briefs/%E0%A4%A`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Invalid brief slug/);
  } finally {
    await server.stop();
  }
});

test('publish --wait-for-response returns a browser submission to the CLI', { timeout: 120_000 }, async () => {
  const server = await startPublishServer('publish-response-wait');
  const reportDir = await makeTempDir('publish-response-report');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Publish Response
---
import { UserRespond } from 'briefkit';

The report can explain the decision before asking for an answer.

<UserRespond id="publish-choice" questions={[{ id: 'choice', type: 'radio', label: 'Choose', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], required: true }]} />
`, 'utf8');

  const child = spawn(process.execPath, [
    '--import',
    'tsx/esm',
    path.join(packageRoot, 'bin', 'briefkit.js'),
    'publish',
    reportDir,
    '--target',
    server.origin,
    '--api-key',
    apiKey,
    '--wait-for-response',
    '--no-open',
    '--no-indexed',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRIEFKIT_CONFIG_DIR: path.join('/tmp', 'briefkit-test-config-disabled'), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  try {
    await waitForText(() => stdout, 'Waiting for a Briefkit response...', child, () => stderr);
    const publishedUrl = stdout.match(/^URL: (https?:\/\/\S+)$/m)?.[1];
    assert(publishedUrl, stdout);
    const html = await (await fetch(publishedUrl)).text();
    const endpoint = requiredMetaContent(html, 'briefkit-response-endpoint');
    const token = requiredMetaContent(html, 'briefkit-response-token');
    const responseBody = {
      schemaVersion: 1,
      formId: 'publish-choice',
      answers: { choice: 'b' },
      submittedAt: '2026-09-13T12:00:00.000Z',
      pageUrl: publishedUrl,
    };
    const submitResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(responseBody),
    });
    assert.equal(submitResponse.status, 201, await submitResponse.text());

    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(child.exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'), responseBody);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await server.stop();
  }
});

test('build and publish make report-root public asset URLs portable under a slug', async () => {
  const tempDir = await makeTempDir('portable-assets');
  const reportDir = await makePortableAssetReport(tempDir);
  const outDir = path.join(tempDir, 'brief');
  const buildResult = await runBriefkit(['build', reportDir, '--out', outDir, '--color-mode', 'auto']);

  assert.equal(buildResult.exitCode, 0, buildResult.stderr);
  const rootHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  const nestedHtml = await fs.readFile(path.join(outDir, 'nested', 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(outDir, 'assets', 'site.css'), 'utf8');
  assertPortableRootHtml(rootHtml, './');
  assertPortableRootHtml(nestedHtml, '../');
  assert.match(css, /url\(\.\.\/images\/from-css\.png\)/);

  const server = await startPublishServer('portable-assets');
  try {
    const publishResult = await runBriefkit([
      'publish',
      reportDir,
      '--out',
      outDir,
      '--target',
      server.origin,
      '--api-key',
      apiKey,
      '--no-indexed',
    ]);

    assert.equal(publishResult.exitCode, 0, publishResult.stderr);
    const slug = 'portable-assets-report';
    assert.equal((await fetch(`${server.origin}/images/hero.png`)).status, 404);
    await assertPublishedPortablePageAssets(server.origin, `/${slug}/`);
    await assertPublishedPortablePageAssets(server.origin, `/${slug}/nested/`);
  } finally {
    await server.stop();
  }
});

test('CLI removes temporary publish output after failed server publish', async () => {
  const tempDir = await makeTempDir('cli-publish-failure');
  const reportDir = await makeBasicReport(tempDir);
  const failingServer = http.createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'forced failure' }));
  });
  await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
  const address = failingServer.address();
  assert(address && typeof address === 'object');
  const publishTempRoot = path.join(tempDir, 'publish-output');
  await fs.mkdir(publishTempRoot);

  try {
    const result = await runBriefkit([
      'publish',
      reportDir,
      '--target',
      `http://127.0.0.1:${address.port}`,
      '--api-key',
      apiKey,
      '--no-indexed',
    ], {
      env: { TMPDIR: publishTempRoot, TMP: publishTempRoot, TEMP: publishTempRoot },
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /forced failure/);
    const remainingPublishOutputs = (await fs.readdir(publishTempRoot))
      .filter((entry) => entry.startsWith('briefkit-publish-'));
    assert.deepEqual(remainingPublishOutputs, []);
  } finally {
    failingServer.close();
  }
});

async function makePortableAssetReport(parentDir: string): Promise<string> {
  const reportDir = path.join(parentDir, 'portable-assets-report');
  await fs.mkdir(path.join(reportDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(reportDir, 'public', 'images'), { recursive: true });
  await fs.mkdir(path.join(reportDir, 'public', 'docs'), { recursive: true });
  await fs.mkdir(path.join(reportDir, 'public', 'assets'), { recursive: true });
  await fs.writeFile(path.join(reportDir, 'briefkit.config.js'), "export default { title: 'Portable Assets Report' };\n", 'utf8');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), portableAssetPage('Root'), 'utf8');
  await fs.writeFile(path.join(reportDir, 'pages', 'nested.mdx'), portableAssetPage('Nested'), 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'images', 'hero.png'), 'hero', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'images', 'hero-2x.png'), 'hero 2x', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'images', 'inline.png'), 'inline', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'images', 'from-style.png'), 'style', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'images', 'from-css.png'), 'css', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'docs', 'file.pdf'), '%PDF test', 'utf8');
  await fs.writeFile(path.join(reportDir, 'public', 'assets', 'site.css'), '.asset-fixture{background:url(/images/from-css.png)}\n', 'utf8');
  return reportDir;
}

function portableAssetPage(title: string): string {
  return `---\ntitle: ${title}\n---\n\n<link rel="stylesheet" href="/assets/site.css" />\n<style>{".style-fixture{background:url('/images/from-style.png')}"}</style>\n<img src="/images/hero.png" srcSet="/images/hero.png 1x, /images/hero-2x.png 2x" style={{ backgroundImage: 'url(/images/inline.png)' }} alt="Hero" />\n<a href="/docs/file.pdf" download>Download PDF</a>\n`;
}

function assertPortableRootHtml(html: string, prefix: string): void {
  assert.match(html, new RegExp(`src="${escapeRegExp(prefix)}images/hero\\.png"`));
  assert.match(html, new RegExp(`href="${escapeRegExp(prefix)}docs/file\\.pdf"`));
  assert.match(html, new RegExp(`href="${escapeRegExp(prefix)}assets/site\\.css"`));
  assert.match(html, new RegExp(`srcset="${escapeRegExp(prefix)}images/hero\\.png 1x, ${escapeRegExp(prefix)}images/hero-2x\\.png 2x"`));
  assert.match(html, new RegExp(`url\\(${escapeRegExp(prefix)}images/inline\\.png\\)`));
  assert.match(html, new RegExp(`url\\('${escapeRegExp(prefix)}images/from-style\\.png'\\)`));
}

async function assertPublishedPortablePageAssets(origin: string, pagePath: string): Promise<void> {
  const pageUrl = `${origin}${pagePath}`;
  const html = await (await fetch(pageUrl)).text();

  await assertResolvedAssetStatus(pageUrl, requiredAttribute(html, 'img', 'src'), 200);
  await assertResolvedAssetStatus(pageUrl, requiredAttribute(html, 'a', 'href'), 200);
  for (const srcsetUrl of requiredAttribute(html, 'img', 'srcset').split(',').map((candidate) => candidate.trim().split(/\s+/)[0])) {
    await assertResolvedAssetStatus(pageUrl, srcsetUrl, 200);
  }

  const stylesheetPath = requiredStylesheetHref(html);
  const stylesheetUrl = new URL(stylesheetPath, pageUrl).href;
  const stylesheetResponse = await fetch(stylesheetUrl);
  assert.equal(stylesheetResponse.status, 200, stylesheetUrl);
  const stylesheet = await stylesheetResponse.text();
  await assertResolvedAssetStatus(stylesheetUrl, requiredCssUrl(stylesheet), 200);

  await assertResolvedAssetStatus(pageUrl, requiredCssUrl(requiredAttribute(html, 'img', 'style')), 200);
  await assertResolvedAssetStatus(pageUrl, requiredCssUrl(requiredStyleElementContentWithUrl(html)), 200);
}

async function assertResolvedAssetStatus(baseUrl: string, assetPath: string, expectedStatus: number): Promise<void> {
  const assetUrl = new URL(assetPath, baseUrl).href;
  const response = await fetch(assetUrl);
  assert.equal(response.status, expectedStatus, `${baseUrl} resolved ${assetPath} to ${assetUrl}`);
}

function requiredAttribute(html: string, tagName: string, attributeName: string): string {
  const value = html.match(new RegExp(`<${tagName}[^>]*${attributeName}="([^"]+)"`, 'i'))?.[1];
  assert(value, `${tagName}[${attributeName}] missing`);
  return value;
}

function requiredStylesheetHref(html: string): string {
  const value = html.match(/<link(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"/i)?.[1];
  assert(value, 'link[rel=stylesheet][href] missing');
  return value;
}

function requiredStyleElementContentWithUrl(html: string): string {
  const value = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .find((content) => /url\(/.test(content));
  assert(value, '<style> content with url(...) missing');
  return value;
}

function requiredCssUrl(css: string): string {
  const value = css.match(/url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/)?.slice(1).find((candidate) => candidate !== undefined)?.trim();
  assert(value, `CSS url(...) missing in ${css}`);
  return value;
}

function requiredMetaContent(html: string, name: string): string {
  const value = html.match(new RegExp(`<meta name="${name}" content="([^"]+)"`))?.[1];
  assert(value, `Missing ${name} meta tag`);
  return value;
}

async function waitForText(
  currentOutput: () => string,
  expected: string,
  child: ChildProcessWithoutNullStreams,
  currentError: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (currentOutput().includes(expected)) return;
    if (child.exitCode !== null) throw new Error(`Process exited before expected output.\n${currentError()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for output.\n${currentOutput()}\n${currentError()}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function startPublishServer(name: string, providedStorageDir?: string, env: Record<string, string> = {}): Promise<PublishServer> {
  const storageDir = providedStorageDir ?? await makeTempDir(`server-storage-${name}`);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, [path.join(packageRoot, 'publish-server', 'server.js')], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BRIEFKIT_DOMAIN: origin,
      BRIEFKIT_API_KEYS: apiKey,
      BRIEFKIT_STORAGE_DIR: storageDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcesses.add(serverProcess);
  await waitForHealth(origin, serverProcess);
  return {
    origin,
    storageDir,
    stop: async () => {
      await stopProcess(serverProcess);
    },
  };
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(origin: string, serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
  let stderr = '';
  serverProcess.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`publish server exited early: ${stderr}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // retry until the server is listening
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`publish server did not start: ${stderr}`);
}

async function stopProcess(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (!serverProcesses.has(serverProcess)) return;
  serverProcesses.delete(serverProcess);
  if (serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => serverProcess.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
}

async function postBodyAfterDelay(url: string, body: string, token: string, delayMs: number): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, text, json: parseJson(text) });
      });
    });
    request.on('error', reject);
    request.write(body.slice(0, 1));
    setTimeout(() => request.end(body.slice(1)), delayMs);
  });
}

async function postJson(origin: string, payload: unknown, key: string | undefined): Promise<HttpResult> {
  return await postRaw(origin, JSON.stringify(payload), key);
}

async function postRaw(origin: string, body: string, key: string | undefined): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${origin}/api/publish`, { method: 'POST', headers, body });
  const text = await response.text();
  return { status: response.status, text, json: parseJson(text) };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function textFile(filePath: string, content: string): { path: string; contentBase64: string } {
  return { path: filePath, contentBase64: Buffer.from(content).toString('base64') };
}

async function publicStorageEntries(storageDir: string): Promise<string[]> {
  const entries = await fs.readdir(storageDir);
  return entries.filter((entry) => !entry.startsWith('.briefkit-')).sort();
}
