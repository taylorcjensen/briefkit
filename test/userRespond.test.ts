import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createLocalResponseWaiter } from '../src/lib/responses.ts';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');

const submission = {
  schemaVersion: 1 as const,
  formId: 'deployment',
  answers: {
    confirm: true,
    targets: ['web', 'worker'],
    strategy: 'rolling',
    window: 'later',
    owner: 'Taylor',
    notes: 'Proceed after the maintenance notice.',
  },
  submittedAt: '2026-09-13T12:00:00.000Z',
  pageUrl: 'http://127.0.0.1/response/',
};

test('UserRespond renders every control type alongside ordinary report content', async () => {
  const reportDir = await makeUserRespondReport();
  const outDir = path.join(reportDir, 'out');
  const result = await runBriefkit(['build', reportDir, '--out', outDir]);

  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /Important deployment constraints/);
  assert.match(html, /data-bk-question-type="checkbox"/);
  assert.match(html, /data-bk-question-type="checkboxes"/);
  assert.match(html, /data-bk-question-type="radio"/);
  assert.match(html, /data-bk-question-type="select"/);
  assert.match(html, /data-bk-question-type="text"/);
  assert.match(html, /data-bk-question-type="textarea"/);
  assert.match(html, /No callback is configured/);
  assert.doesNotMatch(html, /meta name="briefkit-response-endpoint"/);
});

test('UserRespond does not send a generated channel token to an explicit webhook', async () => {
  const html = await buildUserRespondHtml();
  const harness = makeClientScriptHarness(html, {
    explicitAction: 'https://hooks.example.test/submit',
    defaultAction: 'https://briefs.example.test/api/response-channels/channel/submissions',
    defaultToken: 'generated-channel-token',
  });

  await harness.submit();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0]?.url, 'https://hooks.example.test/submit');
  assert.equal(harness.fetchCalls[0]?.headers.authorization, undefined);
  assert.equal(harness.submitButton.disabled, true);
});

test('UserRespond re-enables static submission after copying so answers can be recopied', async () => {
  const html = await buildUserRespondHtml();
  const harness = makeClientScriptHarness(html);

  await harness.submit();
  await harness.submit();

  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.clipboardWrites.length, 2);
  assert.equal(harness.submitButton.disabled, false);
  assert.match(harness.status.textContent, /copied to your clipboard/);
});

test('local response waiter closes stalled request connections within its grace period', async () => {
  const outDir = await makeTempDir('user-respond-stalled-close');
  await fs.writeFile(path.join(outDir, 'index.html'), 'test', 'utf8');
  const waiter = await createLocalResponseWaiter(outDir);
  const endpoint = new URL(waiter.target.endpoint);
  const socket = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write([
    `POST ${endpoint.pathname} HTTP/1.1`,
    `Host: ${endpoint.host}`,
    `Authorization: Bearer ${waiter.target.token}`,
    'Content-Type: application/json',
    'Content-Length: 1000',
    '',
    '{',
  ].join('\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    const closeStartedAt = Date.now();
    await waiter.close();
    assert(Date.now() - closeStartedAt < 2_000, 'Local response waiter close exceeded its bounded grace period');
  } finally {
    socket.destroy();
    await waiter.close();
  }
});

test('build --wait-for-response fails instead of waiting when the report has no form', async () => {
  const reportDir = await makeTempDir('user-respond-missing');
  await fs.writeFile(path.join(reportDir, 'index.md'), '# Report\n\nNo response form.\n', 'utf8');
  const result = await runBriefkit(['build', reportDir, '--out', path.join(reportDir, 'out'), '--wait-for-response', '--no-open']);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /requires at least one rendered UserRespond component/);
});

test('build --wait-for-response serves the brief and returns submitted JSON', { timeout: 120_000 }, async (t) => {
  const reportDir = await makeUserRespondReport();
  const outDir = path.join(reportDir, 'out');
  const port = await reservePort();
  const processHarness = startBriefkit([
    'build',
    reportDir,
    '--out',
    outDir,
    '--port',
    String(port),
    '--wait-for-response',
    '--no-open',
  ]);
  t.after(() => processHarness.stop());

  await processHarness.waitForOutput('Waiting for a Briefkit response...');
  const pageUrl = `http://127.0.0.1:${port}/`;
  const html = await (await fetch(pageUrl)).text();
  const endpoint = requiredMetaContent(html, 'briefkit-response-endpoint');
  const token = requiredMetaContent(html, 'briefkit-response-token');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...submission, pageUrl }),
  });
  assert.equal(response.status, 201, await response.text());

  const result = await processHarness.completed();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Briefkit response received/);
  const returned = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
  assert.deepEqual(returned, { ...submission, pageUrl });
});

interface ClientScriptHarnessOptions {
  explicitAction?: string;
  explicitToken?: string;
  defaultAction?: string;
  defaultToken?: string;
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

interface ClientScriptHarness {
  fetchCalls: FetchCall[];
  clipboardWrites: string[];
  submitButton: { disabled: boolean };
  status: { textContent: string };
  submit: () => Promise<void>;
}

async function buildUserRespondHtml(): Promise<string> {
  const reportDir = await makeUserRespondReport();
  const outDir = path.join(reportDir, 'out');
  const result = await runBriefkit(['build', reportDir, '--out', outDir]);
  assert.equal(result.exitCode, 0, result.stderr);
  return await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
}

function makeClientScriptHarness(html: string, options: ClientScriptHarnessOptions = {}): ClientScriptHarness {
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? '')
    .find((source) => source.includes('initializeUserRespond'));
  assert(script, 'UserRespond client script missing');

  const fetchCalls: FetchCall[] = [];
  const clipboardWrites: string[] = [];
  const submitButton = { disabled: false };
  const status = { textContent: '' };
  let submitHandler: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;

  class MockHtmlFormElement {}
  const form = Object.assign(new MockHtmlFormElement(), {
    dataset: {
      bkResponseId: 'client-test',
      ...(options.explicitAction ? { bkResponseAction: options.explicitAction } : {}),
      ...(options.explicitToken ? { bkResponseToken: options.explicitToken } : {}),
    },
    querySelector(selector: string) {
      if (selector === '.bk-response-status') return status;
      if (selector === '.bk-response-submit') return submitButton;
      return undefined;
    },
    querySelectorAll(selector: string) {
      if (selector === 'input, select, textarea, button') return [submitButton];
      return [];
    },
    addEventListener(type: string, handler: (event: { preventDefault: () => void }) => Promise<void>) {
      if (type === 'submit') submitHandler = handler;
    },
    reportValidity() {
      return true;
    },
  });

  const metaContent = (selector: string): string | undefined => {
    if (selector.includes('briefkit-response-endpoint')) return options.defaultAction;
    if (selector.includes('briefkit-response-token')) return options.defaultToken;
    return undefined;
  };

  runInNewContext(script, {
    HTMLFormElement: MockHtmlFormElement,
    document: {
      querySelectorAll: (selector: string) => selector === '[data-bk-response-form]' ? [form] : [],
      querySelector: (selector: string) => {
        const content = metaContent(selector);
        return content ? { content } : undefined;
      },
    },
    fetch: async (url: string, init: { headers: Record<string, string> }) => {
      fetchCalls.push({ url, headers: init.headers });
      return { ok: true, status: 201, json: async () => ({ accepted: true }) };
    },
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          clipboardWrites.push(value);
        },
      },
    },
    window: { location: { href: 'https://brief.example.test/' } },
  });

  return {
    fetchCalls,
    clipboardWrites,
    submitButton,
    status,
    submit: async () => {
      assert(submitHandler, 'UserRespond submit handler missing');
      await submitHandler({ preventDefault: () => undefined });
    },
  };
}

async function makeUserRespondReport(): Promise<string> {
  const reportDir = await makeTempDir('user-respond');
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Deployment Choices
---
import { Callout, UserRespond } from 'briefkit';

<Callout type="warning" title="Important deployment constraints">
The database must stay available while the application rolls forward.
</Callout>

## Supporting detail

This explanation remains normal MDX and can include tables, diagrams, or source notes.

<UserRespond
  id="deployment"
  title="Deployment decision"
  questions={[
    { id: 'confirm', type: 'checkbox', label: 'I reviewed the constraints', required: true },
    { id: 'targets', type: 'checkboxes', label: 'Targets', required: true, options: [{ value: 'web', label: 'Web' }, { value: 'worker', label: 'Worker' }] },
    { id: 'strategy', type: 'radio', label: 'Strategy', required: true, options: [{ value: 'rolling', label: 'Rolling' }, { value: 'blue-green', label: 'Blue/green' }] },
    { id: 'window', type: 'select', label: 'Window', options: [{ value: 'now', label: 'Now' }, { value: 'later', label: 'Later' }] },
    { id: 'owner', type: 'text', label: 'Owner', placeholder: 'Name' },
    { id: 'notes', type: 'textarea', label: 'Notes', rows: 4 }
  ]}
/>
`, 'utf8');
  return reportDir;
}

function requiredMetaContent(html: string, name: string): string {
  const value = html.match(new RegExp(`<meta name="${name}" content="([^"]+)"`))?.[1];
  assert(value, `Missing ${name} meta tag`);
  return value;
}

function startBriefkit(args: string[]): ProcessHarness {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(packageRoot, 'bin', 'briefkit.js'), ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      BRIEFKIT_CONFIG_DIR: path.join('/tmp', 'briefkit-test-config-disabled'),
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new ProcessHarness(child);
}

class ProcessHarness {
  private stdout = '';
  private stderr = '';

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => { this.stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8'); });
  }

  async waitForOutput(text: string): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (this.stdout.includes(text)) return;
      if (this.child.exitCode !== null) throw new Error(`Briefkit exited before output appeared.\n${this.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Briefkit output.\n${this.stdout}\n${this.stderr}`);
  }

  async completed(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.child.exitCode === null) {
      await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    }
    return { exitCode: this.child.exitCode ?? 1, stdout: this.stdout, stderr: this.stderr };
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
  }
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
