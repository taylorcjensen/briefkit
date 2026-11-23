import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, runBriefkit } from './helpers/process.ts';
import { exposePublishedBrief, publisherFingerprint } from '../publish-server/replacement.js';

const serverFile = path.resolve(import.meta.dirname, '../publish-server/server.js');
const files = (body: string, asset?: string) => [
  { path: 'index.html', contentBase64: Buffer.from(body).toString('base64') },
  ...(asset === undefined ? [] : [{ path: 'old.txt', contentBase64: Buffer.from(asset).toString('base64') }]),
];

test('republish retains URL, removes omitted assets, protects failed uploads and standalone response channels', async () => {
  const storage = await makeTempDir('replace-publish');
  await withServer(storage, 'first,second', async (origin) => {
    const first = await publish(origin, 'first', { title: 'Canonical Name', files: files('original', 'removed') });
    assert.equal(first.status, 201);
    assert.equal(first.body.slug, 'canonical-name');
    const channel = await fetch(`${origin}/api/response-channels`, {
      method: 'POST', headers: { authorization: 'Bearer first', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(channel.status, 201);
    const id = (await channel.json()).id;
    const invalid = await publish(origin, 'first', { title: 'Canonical Name', files: [{ path: 'index.html', contentBase64: 'invalid' }] });
    assert.equal(invalid.status, 400);
    assert.equal(await (await fetch(`${origin}/canonical-name/`)).text(), 'original');
    const second = await publish(origin, 'first', { title: 'Canonical Name', files: files('updated') });
    assert.equal(second.status, 201);
    assert.equal(second.body.slug, 'canonical-name');
    assert.equal(await (await fetch(`${origin}/canonical-name/`)).text(), 'updated');
    assert.equal((await fetch(`${origin}/canonical-name/old.txt`)).status, 404);
    assert.equal((await fetch(`${origin}/api/response-channels/${id}/wait`, { headers: { authorization: 'Bearer bad' } })).status, 401);
    assert.equal((await fs.readdir(storage)).some((entry) => entry.startsWith('.briefkit-replaced-')), false);
  });
});

test('distinct publishers retain assignments and legacy ownership requires explicit operator claim', async () => {
  const storage = await makeTempDir('replace-owners');
  await withServer(storage, 'first,second,third', async (origin) => {
    const first = await publish(origin, 'first', { title: 'Shared', files: files('first') });
    const second = await publish(origin, 'second', { title: 'Shared', files: files('second') });
    const third = await publish(origin, 'third', { title: 'Shared', files: files('third') });
    assert.equal(first.body.slug, 'shared');
    assert.equal(second.body.slug, 'shared-2');
    assert.equal(third.body.slug, 'shared-3');
    assert.equal((await fetch(`${origin}/api/briefs/shared`, { method: 'DELETE', headers: { authorization: 'Bearer second' } })).status, 403);
    assert.equal((await publish(origin, 'second', { title: 'Shared', files: files('second update') })).body.slug, 'shared-2');
    assert.equal((await fetch(`${origin}/api/briefs/shared-2`, { method: 'DELETE', headers: { authorization: 'Bearer second' } })).status, 200);
    assert.equal((await publish(origin, 'third', { title: 'Shared', files: files('third update') })).body.slug, 'shared-3');
    assert.equal(await (await fetch(`${origin}/shared/`)).text(), 'first');
    assert.equal(await (await fetch(`${origin}/shared-3/`)).text(), 'third update');
    assert.equal((await fs.readFile(path.join(storage, 'shared', '.briefkit.json'), 'utf8')).includes('first'), false);
  });
  const legacyDir = path.join(storage, 'legacy');
  await fs.mkdir(legacyDir);
  await fs.writeFile(path.join(legacyDir, '.briefkit.json'), JSON.stringify({ title: 'Legacy', slug: 'legacy', indexed: true }));
  await fs.writeFile(path.join(legacyDir, 'index.html'), 'legacy version');
  await withServer(storage, 'first,second', async (origin) => {
    const conflict = await publish(origin, 'first', { title: 'Legacy', files: files('new') });
    assert.equal(conflict.status, 409);
    assert.match(String(conflict.body.error), /operator.*claim or remove/);
    assert.equal(await (await fetch(`${origin}/legacy/`)).text(), 'legacy version');
    assert.equal((await fs.readdir(storage)).includes('legacy-2'), false);
  });
});

test('CLI republishes a regenerated report from another directory at the same URL', { timeout: 120_000 }, async () => {
  const storage = await makeTempDir('replace-cli-storage');
  const source = await makeTempDir('replace-cli-source');
  await withServer(storage, 'first', async (origin) => {
    for (const [folder, content] of [['one', 'First edition'], ['two', 'Second edition']]) {
      const reportDir = path.join(source, folder);
      await fs.mkdir(reportDir);
      await fs.writeFile(path.join(reportDir, 'briefkit.config.mjs'), "export default { title: 'Regenerated Brief' };\n");
      await fs.writeFile(path.join(reportDir, 'index.md'), `# ${content}\n`);
      const result = await runBriefkit(['publish', reportDir, '--target', origin, '--api-key', 'first', '--no-open']);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`URL: ${origin}/regenerated-brief/`));
    }
    assert.match(await (await fetch(`${origin}/regenerated-brief/`)).text(), /Second edition/);
    assert.equal((await fs.readdir(storage)).includes('regenerated-brief-2'), false);
  });
});

test('failed installation restores the working directory and its assets', async () => {
  const storage = await makeTempDir('replace-install-failure');
  const live = path.join(storage, 'stable');
  const staging = path.join(storage, '.briefkit-staging-test');
  await fs.mkdir(live);
  await fs.mkdir(staging);
  await fs.writeFile(path.join(live, '.briefkit.json'), JSON.stringify({ baseSlug: 'stable', publisherFingerprint: publisherFingerprint('first') }));
  await fs.writeFile(path.join(live, 'index.html'), 'working');
  await fs.writeFile(path.join(live, 'old.txt'), 'asset');
  await fs.writeFile(path.join(staging, 'index.html'), 'replacement');
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (source === staging && destination === live) throw new Error('injected install failure');
    return rename(source, destination);
  };
  try {
    await assert.rejects(exposePublishedBrief({
      storageDir: storage, stagingDir: staging, baseSlug: 'stable', fingerprint: publisherFingerprint('first'),
      metadata: { title: 'Stable' },
    }), /injected install failure/);
  } finally {
    fs.rename = rename;
  }
  assert.equal(await fs.readFile(path.join(live, 'index.html'), 'utf8'), 'working');
  assert.equal(await fs.readFile(path.join(live, 'old.txt'), 'utf8'), 'asset');
  assert.equal((await fs.readdir(storage)).includes('.briefkit-replaced-stable'), false);
});

test('restart recovers an interrupted replacement without losing the old brief', async () => {
  const storage = await makeTempDir('replace-recovery');
  await withServer(storage, 'first', async (origin) => {
    assert.equal((await publish(origin, 'first', { title: 'Recovery', files: files('working') })).status, 201);
  });
  await fs.rename(path.join(storage, 'recovery'), path.join(storage, '.briefkit-replaced-recovery'));
  await withServer(storage, 'first', async (origin) => {
    assert.equal(await (await fetch(`${origin}/recovery/`)).text(), 'working');
    assert.equal((await fs.readdir(storage)).includes('.briefkit-replaced-recovery'), false);
  });
});

async function publish(origin: string, key: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/publish`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function withServer(storage: string, keys: string, check: (origin: string) => Promise<void>): Promise<void> {
  const listener = http.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(address.port), BRIEFKIT_DOMAIN: origin, BRIEFKIT_API_KEYS: keys, BRIEFKIT_STORAGE_DIR: storage },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      try { if ((await fetch(`${origin}/health`)).ok) { healthy = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(healthy, stderr);
    await check(origin);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}
