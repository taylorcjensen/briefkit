import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const storageDir = process.env.BRIEFKIT_STORAGE_DIR || '/briefs';
const domain = normalizeDomain(process.env.BRIEFKIT_DOMAIN || process.env.DOMAIN || 'http://localhost:8080');
const apiKeys = new Set((process.env.BRIEFKIT_API_KEYS || process.env.API_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean));
const defaultDuration = process.env.BRIEFKIT_DEFAULT_DURATION || process.env.DEFAULT_DURATION || '3mo';
const defaultIndexed = parseBoolean(process.env.BRIEFKIT_DEFAULT_INDEXED ?? process.env.DEFAULT_INDEXED ?? 'true');
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
  const indexed = payload.indexed === undefined || payload.indexed === null ? defaultIndexed : assertBoolean(payload.indexed, 'indexed');
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

  const metadata = { title, slug, createdAt: new Date().toISOString(), expiresAt, duration: requestedDuration, indexed };
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
  if (url.pathname === '/') {
    await serveBriefIndex(request, response);
    return;
  }

  const pathname = decodeURIComponent(url.pathname);
  const relativePath = sanitizeRelativePath(pathname);
  const candidate = path.join(storageDir, relativePath);
  const filePath = await resolveStaticFile(candidate);
  if (!filePath || await isInsideExpiredBrief(filePath)) {
    sendNotFound(response);
    return;
  }

  const data = request.method === 'HEAD' ? undefined : await readStaticResponseBody(filePath, url);
  response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'public, max-age=60' });
  response.end(data);
}

async function readStaticResponseBody(filePath, requestUrl) {
  const data = await fs.readFile(filePath);
  if (contentType(filePath) !== 'text/html; charset=utf-8') return data;
  return updatePreviewUrls(data.toString('utf8'), requestUrl);
}

function updatePreviewUrls(html, requestUrl) {
  const publicUrl = publicRequestUrl(requestUrl);
  const slug = requestUrl.pathname.split('/').filter(Boolean)[0];
  const withCanonical = upsertHeadTag(html, 'link', 'rel', 'canonical', `<link rel="canonical" href="${escapeHtml(publicUrl)}">`);
  const withOpenGraphUrl = upsertHeadTag(withCanonical, 'meta', 'property', 'og:url', `<meta property="og:url" content="${escapeHtml(publicUrl)}">`);
  return withOpenGraphUrl
    .replace(/(<meta\s+(?:[^>]*\s)?property=["']og:image["'][^>]*\scontent=["'])([^"']+)(["'][^>]*>)/i, (_match, before, value, after) => `${before}${escapeHtml(publishedAssetUrl(value, slug))}${after}`)
    .replace(/(<meta\s+(?:[^>]*\s)?name=["']twitter:image["'][^>]*\scontent=["'])([^"']+)(["'][^>]*>)/i, (_match, before, value, after) => `${before}${escapeHtml(publishedAssetUrl(value, slug))}${after}`);
}

function upsertHeadTag(html, tagName, attributeName, attributeValue, replacement) {
  const pattern = new RegExp(`<${tagName}\\s+[^>]*${attributeName}=["']${escapeRegExp(attributeValue)}["'][^>]*>`, 'i');
  if (pattern.test(html)) return html.replace(pattern, replacement);
  return html.replace(/<head>/i, `<head>${replacement}`);
}

function publicRequestUrl(requestUrl) {
  return `${domain}${requestUrl.pathname}`;
}

function publishedAssetUrl(value, slug) {
  try {
    const url = new URL(value, domain);
    if (!slug || url.origin !== new URL(domain).origin) return value;
    const pathname = url.pathname.replace(/^\/+/, '');
    return `${domain}/${slug}/${pathname}`;
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function serveBriefIndex(request, response) {
  const briefs = await indexedBriefs();
  const body = request.method === 'HEAD' ? undefined : briefIndexHtml(briefs);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
  response.end(body);
}

async function indexedBriefs() {
  const entries = await fs.readdir(storageDir, { withFileTypes: true });
  const briefs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadata = await readMetadata(path.join(storageDir, entry.name));
    if (!metadata || metadata.indexed === false || isExpired(metadata.expiresAt)) continue;
    briefs.push({
      title: typeof metadata.title === 'string' ? metadata.title : entry.name,
      slug: entry.name,
      createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : '',
      expiresAt: metadata.expiresAt ?? null,
      duration: typeof metadata.duration === 'string' ? metadata.duration : '',
    });
  }
  return briefs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function briefIndexHtml(briefs) {
  const rows = briefs.map((brief) => `<tr><td><a href="/${escapeHtml(brief.slug)}/">${escapeHtml(brief.title)}</a></td><td>${escapeHtml(formatDate(brief.createdAt))}</td><td>${escapeHtml(formatExpiry(brief.expiresAt))}</td></tr>`).join('');
  const table = rows || '<tr><td colspan="3" class="bk-empty">No indexed briefs yet.</td></tr>';
  return `<!DOCTYPE html><html lang="en" data-bk-theme="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Briefs</title><style>${briefIndexCss()}</style></head><body><div class="bk-shell"><header class="bk-header"><div><div class="bk-report-title">Briefkit</div><h1>Briefs</h1></div></header><main class="bk-content"><section class="bk-callout"><div class="bk-callout-label">Index</div><h2 class="bk-callout-title">Published briefs</h2><p>Recent indexed briefs hosted on this server.</p></section><div class="bk-table-wrap"><table><thead><tr><th>Brief</th><th>Published</th><th>Expires</th></tr></thead><tbody>${table}</tbody></table></div></main></div></body></html>`;
}

function briefIndexCss() {
  return `:root{color-scheme:light dark;--bk-bg:#f7f5ef;--bk-paper:#fffefa;--bk-ink:#171717;--bk-muted:#5e5a52;--bk-line:#d2ccc0;--bk-head:#eee9dd;--bk-accent:#6a4a16;--bk-link:#315f67;--bk-callout-bg:#fff8df;--bk-callout-line:#b99b4b}@media (prefers-color-scheme:dark){:root[data-bk-theme=auto]{--bk-bg:#1d2021;--bk-paper:#282828;--bk-ink:#ebdbb2;--bk-muted:#bdae93;--bk-line:#665c54;--bk-head:#3c3836;--bk-accent:#d79921;--bk-link:#83a598;--bk-callout-bg:#32302f;--bk-callout-line:#d79921}}*{box-sizing:border-box}body{margin:0;background:var(--bk-bg);color:var(--bk-ink);font:15px/1.48 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--bk-link);text-decoration-thickness:.08em;text-underline-offset:.18em}.bk-shell{max-width:1120px;margin:0 auto;padding:0 20px}.bk-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:22px 0 16px;border-bottom:2px solid var(--bk-ink)}.bk-report-title{margin-bottom:4px;color:var(--bk-muted);font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{margin:0;font-size:clamp(28px,4vw,44px);line-height:1.05}.bk-content{min-width:0;padding:18px 0 28px}.bk-callout{margin:18px 0 24px;padding:14px 16px;background:var(--bk-callout-bg);border:1px solid var(--bk-callout-line);border-left:5px solid var(--bk-accent);box-shadow:0 1px 0 rgba(0,0,0,.04)}.bk-callout-label{margin-bottom:4px;color:var(--bk-accent);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.bk-callout-title{margin:0 0 6px!important;padding:0!important;border:0!important;font-size:18px!important}.bk-callout p{margin:0}.bk-table-wrap{width:100%;margin:10px 0 20px}table{width:100%;border-collapse:collapse;background:var(--bk-paper);table-layout:fixed}th,td{border:1px solid var(--bk-line);padding:9px 10px;text-align:left;vertical-align:top;overflow-wrap:break-word}th{background:var(--bk-head);font-weight:800}td{color:var(--bk-ink)}.bk-empty{color:var(--bk-muted);text-align:center}`;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatExpiry(value) {
  if (value === null) return 'Never';
  return formatDate(value);
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

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`);
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

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
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
    '.mjs': 'text/javascript; charset=utf-8',
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
