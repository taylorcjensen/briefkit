import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';

const MAX_RESPONSE_BYTES = 256 * 1024;
const LOCAL_SERVER_CLOSE_GRACE_MS = 250;

export interface BriefkitSubmission {
  schemaVersion: 1;
  formId: string;
  answers: Record<string, boolean | string | string[]>;
  submittedAt: string;
  pageUrl: string;
}

export interface ResponseTarget {
  endpoint: string;
  token: string;
}

export interface LocalResponseWaiter {
  pageUrl: string;
  target: ResponseTarget;
  wait: () => Promise<BriefkitSubmission>;
  close: () => Promise<void>;
}

export interface RemoteResponseChannel {
  id: string;
  submitUrl: string;
  submitToken: string;
  waitUrl: string;
  waitToken: string;
  expiresAt: string;
}

export async function createLocalResponseWaiter(outDir: string, requestedPort?: number): Promise<LocalResponseWaiter> {
  const channelId = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(32).toString('base64url');
  const submitPath = `/__briefkit/responses/${channelId}`;
  let receivedSubmission: BriefkitSubmission | undefined;
  let isSubmissionPending = false;
  let resolveSubmission: ((submission: BriefkitSubmission) => void) | undefined;
  const submissionPromise = new Promise<BriefkitSubmission>((resolve) => { resolveSubmission = resolve; });
  const activeSockets = new Set<Socket>();

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && requestUrl.pathname === submitPath) {
        if (!hasBearerToken(request, token)) {
          sendJson(response, 401, { error: 'Unauthorized' });
          return;
        }
        if (receivedSubmission || isSubmissionPending) {
          sendJson(response, 409, { error: 'A response has already been submitted' });
          return;
        }
        isSubmissionPending = true;
        try {
          receivedSubmission = parseSubmission(await readRequestBody(request, MAX_RESPONSE_BYTES));
        } catch (error) {
          isSubmissionPending = false;
          throw error;
        }
        sendJson(response, 201, { accepted: true });
        resolveSubmission?.(receivedSubmission);
        return;
      }
      await serveBuiltFile(request, response, outDir);
    } catch (error) {
      if (error instanceof ResponseHttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      if (request.destroyed && isConnectionAbort(error)) return;
      console.error(error);
      sendJson(response, 500, { error: 'Internal response server error' });
    }
  });
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Briefkit could not determine the local response server address.');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    pageUrl: `${origin}/`,
    target: { endpoint: `${origin}${submitPath}`, token },
    wait: () => submissionPromise,
    close: async () => {
      await closeLocalServer(server, activeSockets);
    },
  };
}

export async function createRemoteResponseChannel(target: string, apiKey: string): Promise<RemoteResponseChannel> {
  const response = await fetch(`${target}/api/response-channels`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const payload = await response.json().catch(() => ({})) as Partial<RemoteResponseChannel> & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Could not create response channel: HTTP ${response.status}`);
  if (!payload.id || !payload.submitUrl || !payload.submitToken || !payload.waitUrl || !payload.waitToken || !payload.expiresAt) {
    throw new Error('Publish server returned an invalid response channel.');
  }
  return payload as RemoteResponseChannel;
}

export async function waitForRemoteResponse(channel: RemoteResponseChannel): Promise<BriefkitSubmission> {
  while (true) {
    const response = await fetch(channel.waitUrl, {
      headers: { authorization: `Bearer ${channel.waitToken}` },
    });
    if (response.status === 204) continue;
    const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<BriefkitSubmission>;
    if (!response.ok) throw new Error(payload.error ?? `Could not wait for response: HTTP ${response.status}`);
    return parseSubmission(JSON.stringify(payload));
  }
}

export async function deleteRemoteResponseChannel(channel: RemoteResponseChannel): Promise<void> {
  const response = await fetch(channel.waitUrl, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${channel.waitToken}` },
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  const payload = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(payload.error ?? `Could not delete response channel: HTTP ${response.status}`);
}

function parseSubmission(body: string): BriefkitSubmission {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ResponseHttpError(400, 'Response body must be valid JSON');
  }
  if (!isPlainObject(value)) throw new ResponseHttpError(400, 'Response body must be a JSON object');
  if (value.schemaVersion !== 1) throw new ResponseHttpError(400, 'schemaVersion must be 1');
  if (typeof value.formId !== 'string' || value.formId.length === 0 || value.formId.length > 200) {
    throw new ResponseHttpError(400, 'formId must be a non-empty string no longer than 200 characters');
  }
  if (!isPlainObject(value.answers)) throw new ResponseHttpError(400, 'answers must be a JSON object');
  for (const answer of Object.values(value.answers)) {
    if (typeof answer === 'boolean' || typeof answer === 'string') continue;
    if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) continue;
    throw new ResponseHttpError(400, 'answer values must be booleans, strings, or arrays of strings');
  }
  if (typeof value.submittedAt !== 'string' || Number.isNaN(Date.parse(value.submittedAt))) {
    throw new ResponseHttpError(400, 'submittedAt must be an ISO date string');
  }
  if (typeof value.pageUrl !== 'string' || value.pageUrl.length === 0 || value.pageUrl.length > 4_000) {
    throw new ResponseHttpError(400, 'pageUrl must be a non-empty string no longer than 4000 characters');
  }
  return value as unknown as BriefkitSubmission;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new ResponseHttpError(413, 'Response is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hasBearerToken(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization ?? '';
  const receivedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (receivedToken.length !== expectedToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(receivedToken), Buffer.from(expectedToken));
}

async function serveBuiltFile(request: IncomingMessage, response: ServerResponse, outDir: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    throw new ResponseHttpError(400, 'Invalid path');
  }
  const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
  const root = path.resolve(outDir);
  let filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new ResponseHttpError(400, 'Invalid path');

  const stat = await statOrUndefined(filePath);
  if (stat?.isDirectory()) filePath = path.join(filePath, 'index.html');
  const fileStat = await statOrUndefined(filePath);
  if (!fileStat?.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': responseContentType(filePath),
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : await fs.readFile(filePath));
}

async function statOrUndefined(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function responseContentType(filePath: string): string {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  }[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(response: ServerResponse, status: number, payload: object): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function isConnectionAbort(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ECONNRESET' || code === 'ECONNABORTED';
}

async function closeLocalServer(server: http.Server, activeSockets: ReadonlySet<Socket>): Promise<void> {
  if (!server.listening) return;
  let forceCloseTimer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    forceCloseTimer = setTimeout(() => {
      for (const socket of activeSockets) socket.destroy();
    }, LOCAL_SERVER_CLOSE_GRACE_MS);
    server.close((error) => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    });
  });
}

class ResponseHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
