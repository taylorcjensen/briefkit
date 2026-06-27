import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const storageDir = process.env.BRIEFKIT_STORAGE_DIR || '/briefs';
const domain = normalizeDomain(process.env.BRIEFKIT_DOMAIN || process.env.DOMAIN || 'http://localhost:8080');
const apiKeys = new Set((process.env.BRIEFKIT_API_KEYS || process.env.API_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean));
const defaultDuration = process.env.BRIEFKIT_DEFAULT_DURATION || process.env.DEFAULT_DURATION || '3mo';
const port = Number(process.env.PORT || 8080);
const maxBodyBytes = Number(process.env.BRIEFKIT_MAX_BODY_BYTES || 50 * 1024 * 1024);

if (apiKeys.size === 0) {
  console.error('BRIEFKIT_API_KEYS is required. Use a comma-separated list for multiple keys.');
  process.exit(1);
}

await fs.mkdir(storageDir, { recursive: true });
await cleanupExpiredBriefs();
setInterval(() => cleanupExpiredBriefs().catch((error) => console.error(error)), 60 * 60 * 1000).unref();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/publish') {
      await handlePublish(request, response);
      return;
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/api/briefs/')) {
      await handleDelete(request, response);
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    await serveStaticFile(request, response);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: 'Internal server error' });
  }
});

server.listen(port, () => {
  console.log(`Briefkit publish server listening on ${port}`);
});

async function handlePublish(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const payload = JSON.parse(await readBody(request));
  const title = assertString(payload.title, 'title');
  const requestedDuration = payload.duration === undefined || payload.duration === null ? defaultDuration : assertString(payload.duration, 'duration');
  const expiresAt = calculateExpiresAt(requestedDuration);
  const files = assertFiles(payload.files);
  const slug = await reserveSlug(slugify(title));
  const briefDir = path.join(storageDir, slug);

  await fs.mkdir(briefDir, { recursive: true });
  for (const file of files) {
    const relativePath = sanitizeRelativePath(file.path);
    const destination = path.join(briefDir, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(file.contentBase64, 'base64'));
  }

  const metadata = { title, slug, createdAt: new Date().toISOString(), expiresAt, duration: requestedDuration };
  await fs.writeFile(path.join(briefDir, '.briefkit.json'), JSON.stringify(metadata, null, 2));

  sendJson(response, 201, { url: `${domain}/${slug}/`, slug, expiresAt });
}

async function handleDelete(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const url = new URL(request.url || '/', domain);
  const slug = sanitizeSlug(url.pathname.replace(/^\/api\/briefs\//, ''));
  const briefDir = path.join(storageDir, slug);
  const stat = await statOrUndefined(briefDir);
  if (!stat?.isDirectory()) {
    sendJson(response, 404, { error: 'Brief not found' });
    return;
  }

  await fs.rm(briefDir, { recursive: true, force: true });
  sendJson(response, 200, { deleted: true, slug });
}

async function serveStaticFile(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const url = new URL(request.url || '/', domain);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = sanitizeRelativePath(pathname);
  const candidate = path.join(storageDir, relativePath);
  const filePath = await resolveStaticFile(candidate);
  if (!filePath || await isInsideExpiredBrief(filePath)) {
    sendNotFound(response);
    return;
  }

  const data = request.method === 'HEAD' ? undefined : await fs.readFile(filePath);
  response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'public, max-age=60' });
  response.end(data);
}

async function resolveStaticFile(candidate) {
  const safeCandidate = await ensureInsideStorage(candidate);
  const stat = await statOrUndefined(safeCandidate);
  if (stat?.isFile()) return safeCandidate;
  if (stat?.isDirectory()) {
    const indexPath = path.join(safeCandidate, 'index.html');
    if ((await statOrUndefined(indexPath))?.isFile()) return indexPath;
  }
  return undefined;
}

async function isInsideExpiredBrief(filePath) {
  const relative = path.relative(storageDir, filePath);
  const slug = relative.split(path.sep)[0];
  if (!slug) return false;
  const metadata = await readMetadata(path.join(storageDir, slug));
  return metadata ? isExpired(metadata.expiresAt) : false;
}

async function cleanupExpiredBriefs() {
  const entries = await fs.readdir(storageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const briefDir = path.join(storageDir, entry.name);
    const metadata = await readMetadata(briefDir);
    if (metadata && isExpired(metadata.expiresAt)) {
      await fs.rm(briefDir, { recursive: true, force: true });
    }
  }
}

async function readMetadata(briefDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(briefDir, '.briefkit.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function reserveSlug(baseSlug) {
  let suffix = 1;
  let slug = baseSlug;
  while (await exists(path.join(storageDir, slug))) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }
  return slug;
}

function calculateExpiresAt(duration) {
  if (duration === 'forever') return null;
  const match = /^(\d+)(d|w|mo|y)$/.exec(duration);
  if (!match) throw new HttpError(400, 'duration must be forever or a value like 90d, 3mo, or 1y');
  const amount = Number(match[1]);
  const date = new Date();
  if (match[2] === 'd') date.setDate(date.getDate() + amount);
  if (match[2] === 'w') date.setDate(date.getDate() + amount * 7);
  if (match[2] === 'mo') date.setMonth(date.getMonth() + amount);
  if (match[2] === 'y') date.setFullYear(date.getFullYear() + amount);
  return date.toISOString();
}

function isExpired(expiresAt) {
  return typeof expiresAt === 'string' && new Date(expiresAt).getTime() <= Date.now();
}

function isAuthorized(request) {
  const header = request.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const apiKey = request.headers['x-api-key'] || bearer;
  return typeof apiKey === 'string' && apiKeys.has(apiKey);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Upload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function assertFiles(value) {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'files must be a non-empty array');
  return value.map((file) => ({
    path: assertString(file.path, 'file.path'),
    contentBase64: assertString(file.contentBase64, 'file.contentBase64'),
  }));
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`);
  return value;
}

function sanitizeRelativePath(value) {
  const normalized = value.replace(/^\/+/, '');
  if (normalized.includes('\0')) throw new HttpError(400, 'Invalid path');
  const resolved = path.resolve(storageDir, normalized);
  if (!resolved.startsWith(path.resolve(storageDir) + path.sep) && resolved !== path.resolve(storageDir)) {
    throw new HttpError(400, 'Invalid path');
  }
  return normalized;
}

async function ensureInsideStorage(value) {
  const resolved = path.resolve(value);
  if (!resolved.startsWith(path.resolve(storageDir) + path.sep) && resolved !== path.resolve(storageDir)) {
    throw new HttpError(400, 'Invalid path');
  }
  return resolved;
}

function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || 'brief';
}

function sanitizeSlug(value) {
  const slug = decodeURIComponent(value).replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new HttpError(400, 'Invalid brief slug');
  return slug;
}

function normalizeDomain(value) {
  return value.replace(/\/+$/, '');
}

async function exists(value) {
  return Boolean(await statOrUndefined(value));
}

async function statOrUndefined(value) {
  try {
    return await fs.stat(value);
  } catch {
    return undefined;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendNotFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found');
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  }[extension] || 'application/octet-stream';
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
