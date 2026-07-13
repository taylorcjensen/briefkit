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
