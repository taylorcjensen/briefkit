import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The credential is never persisted. Its fingerprint scopes a title to its publisher.
export function publisherFingerprint(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export async function exposePublishedBrief({ storageDir, stagingDir, baseSlug, metadata, fingerprint }) {
  // A global allocation lock also protects suffixes that collide with another title's base slug.
  const releaseAllocation = await lockDirectory(storageDir, '.briefkit-lock-global');
  try {
    return await withTitleLock(storageDir, baseSlug, async () => {
      const { slug, replacing } = await assignedSlug(storageDir, baseSlug, fingerprint);
      const destination = path.join(storageDir, slug);
      const rollback = path.join(storageDir, `.briefkit-replaced-${slug}`);
      if (await exists(rollback)) throw new Error(`Pending publish recovery for ${slug}; restart the publish server`);
      if (!replacing && await exists(destination)) throw new Error(`Publish destination ${slug} changed; retry`);
      await fs.writeFile(path.join(stagingDir, '.briefkit.json'), JSON.stringify({ ...metadata, slug, publisherFingerprint: fingerprint }, null, 2));
      if (replacing) await fs.rename(destination, rollback);
      try {
        await fs.rename(stagingDir, destination);
      } catch (error) {
        if (replacing) await fs.rename(rollback, destination);
        throw error;
      }
      if (replacing) {
        try { await fs.rm(rollback, { recursive: true, force: true }); }
        catch (error) { console.warn(`Could not purge replaced files for ${slug}: ${error}`); }
      }
      return slug;
    });
  } finally {
    await releaseAllocation();
  }
}

async function assignedSlug(storageDir, baseSlug, fingerprint) {
  let unowned = false;
  // Examine every assignment, including ones beyond a gap left by an unpublished brief.
  const entries = await fs.readdir(storageDir);
  const candidates = entries.filter((entry) => entry === baseSlug || (entry.startsWith(`${baseSlug}-`) && /^[2-9][0-9]*$/.test(entry.slice(baseSlug.length + 1))));
  for (const slug of candidates) {
    const stat = await fs.lstat(path.join(storageDir, slug));
    const record = stat.isDirectory() ? await readMetadata(path.join(storageDir, slug)) : undefined;
    if (record?.publisherFingerprint === fingerprint && record?.baseSlug === baseSlug) return { slug, replacing: true };
    if (!record?.publisherFingerprint && slug === baseSlug) unowned = true;
  }
  if (unowned) {
    const error = new Error(`An existing brief at ${baseSlug} has no provable publisher. Ask the server operator to claim or remove the legacy brief before republishing.`);
    error.status = 409;
    throw error;
  }
  const used = new Set(entries);
  let suffix = 1;
  while (used.has(suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`)) suffix += 1;
  return { slug: suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`, replacing: false };
}

async function readMetadata(directory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, '.briefkit.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function exists(destination) {
  try { await fs.lstat(destination); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function withTitleLock(storageDir, baseSlug, action) {
  const release = await lockTitle(storageDir, baseSlug);
  try { return await action(); }
  finally { await release(); }
}

async function lockTitle(storageDir, baseSlug) {
  return lockDirectory(storageDir, `.briefkit-lock-${baseSlug}`);
}

async function lockDirectory(storageDir, name) {
  const lock = path.join(storageDir, name);
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      return async () => fs.rmdir(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        const busy = new Error(`Publish lock ${name} is busy; retry shortly`);
        busy.status = 409;
        throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Restore the last working brief if a process stopped between the two renames.
export async function recoverInterruptedReplacements(storageDir) {
  for (const name of await fs.readdir(storageDir)) {
    if (!name.startsWith('.briefkit-replaced-')) continue;
    const slug = name.slice('.briefkit-replaced-'.length);
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) continue;
    const rollback = path.join(storageDir, name);
    if (!(await fs.lstat(rollback)).isDirectory()) continue;
    const destination = path.join(storageDir, slug);
    if (await exists(destination)) await fs.rm(rollback, { recursive: true, force: true });
    else await fs.rename(rollback, destination);
  }
}
