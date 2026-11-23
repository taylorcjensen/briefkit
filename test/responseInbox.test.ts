import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalResponseWaiter } from '../src/lib/responses.ts';
import { readLocalResponses } from '../src/lib/responseInbox.ts';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

const submission = {
  schemaVersion: 1 as const,
  formId: 'choice',
  answers: { answer: 'first' },
  submittedAt: '2026-09-13T12:00:00.000Z',
  pageUrl: 'http://127.0.0.1/',
};

test('loopback submissions persist outside static output after shutdown and CLI retrieves all', async () => {
  const dir = await makeTempDir('response-inbox-local');
  const outDir = path.join(dir, 'built');
  const storageDir = path.join(dir, 'private');
  await fs.mkdir(outDir);
  await fs.writeFile(path.join(outDir, 'index.html'), 'Report');
  const previous = process.env.BRIEFKIT_RESPONSE_STORAGE_DIR;
  process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = storageDir;
  const waiter = await createLocalResponseWaiter(outDir);
  try {
    for (const answer of ['first', 'revised']) {
      const response = await fetch(waiter.target.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${waiter.target.token}`, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.5' },
        body: JSON.stringify({ ...submission, answers: { answer } }),
      });
      assert.equal(response.status, 201, await response.text());
    }
    assert.deepEqual(await waiter.wait(), submission);
    assert.equal((await fetch(`${waiter.pageUrl}private/${waiter.id}/`)).status, 404);
  } finally {
    await waiter.close();
    if (previous === undefined) delete process.env.BRIEFKIT_RESPONSE_STORAGE_DIR;
    else process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = previous;
  }
  const records = await (async () => {
    process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = storageDir;
    try { return await readLocalResponses(waiter.id); }
    finally {
      if (previous === undefined) delete process.env.BRIEFKIT_RESPONSE_STORAGE_DIR;
      else process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = previous;
    }
  })();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.submission.answers.answer), ['first', 'revised']);
  assert(records.every((record) => record.revisionId === waiter.id && !('ip' in record)));
  const result = await runBriefkit(['responses', waiter.id, '--local'], { env: { BRIEFKIT_RESPONSE_STORAGE_DIR: storageDir } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { responses: unknown[] }).responses.length, 2);
  await assert.rejects(fs.access(path.join(outDir, 'private')));
});

test('local IP capture is opt-in and uses socket address, not forwarded header', async () => {
  const dir = await makeTempDir('response-inbox-ip');
  const storageDir = path.join(dir, 'private');
  const outDir = path.join(dir, 'built');
  await fs.mkdir(outDir);
  await fs.writeFile(path.join(outDir, 'index.html'), 'Report');
  const previous = process.env.BRIEFKIT_RESPONSE_STORAGE_DIR;
  process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = storageDir;
  const waiter = await createLocalResponseWaiter(outDir, undefined, true);
  try {
    const response = await fetch(waiter.target.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${waiter.target.token}`, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.5' },
      body: JSON.stringify(submission),
    });
    assert.equal(response.status, 201);
    const records = await readLocalResponses(waiter.id);
    assert.equal(records[0].ip, '127.0.0.1');
  } finally {
    await waiter.close();
    if (previous === undefined) delete process.env.BRIEFKIT_RESPONSE_STORAGE_DIR;
    else process.env.BRIEFKIT_RESPONSE_STORAGE_DIR = previous;
  }
});


test('build --serve-responses accepts multiple answers while running and retrieves after shutdown', { timeout: 120_000 }, async () => {
  const dir = await makeTempDir('response-inbox-cli');
  const reportDir = path.join(dir, 'report');
  const storageDir = path.join(dir, 'private');
  await fs.mkdir(reportDir);
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Local Inbox
---
import { UserRespond } from 'briefkit';

<UserRespond id="choice" questions={[{ id: 'answer', type: 'text', label: 'Answer' }]} />
`);
  const child = spawn(process.execPath, ['--import', 'tsx/esm', path.resolve(import.meta.dirname, '..', 'bin', 'briefkit.js'), 'build', reportDir, '--serve-responses', '--no-open'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, BRIEFKIT_TSX_RUN: '1', BRIEFKIT_RESPONSE_STORAGE_DIR: storageDir, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    for (let attempt = 0; attempt < 600 && !stdout.includes('Serving responses until interrupted.'); attempt++) {
      if (child.exitCode !== null) throw new Error(stderr);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(stdout, /Serving responses until interrupted\./, stderr);
    const url = stdout.match(/^URL: (\S+)$/m)?.[1];
    const revisionId = stdout.match(/^Revision ID: ([a-f0-9]{32})$/m)?.[1];
    assert(url && revisionId, stdout);
    const html = await (await fetch(url)).text();
    const endpoint = html.match(/<meta name="briefkit-response-endpoint" content="([^"]+)"/)?.[1];
    const token = html.match(/<meta name="briefkit-response-token" content="([^"]+)"/)?.[1];
    assert(endpoint && token, html);
    for (const answer of ['one', 'two']) {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...submission, answers: { answer } }),
      });
      assert.equal(response.status, 201, await response.text());
    }
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const retrieved = await runBriefkit(['responses', revisionId, '--local'], { env: { BRIEFKIT_RESPONSE_STORAGE_DIR: storageDir } });
    assert.equal(retrieved.exitCode, 0, retrieved.stderr);
    assert.deepEqual((JSON.parse(retrieved.stdout) as { responses: { submission: { answers: { answer: string } } }[] }).responses.map((record) => record.submission.answers.answer), ['one', 'two']);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
});
