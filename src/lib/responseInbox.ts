import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BriefkitSubmission } from './responses.js';

export interface StoredResponse {
  submissionId: string;
  receivedAt: string;
  revisionId: string;
  submission: BriefkitSubmission;
  ip?: string;
}

export function localResponseRoot(): string {
  return process.env.BRIEFKIT_RESPONSE_STORAGE_DIR || path.join(os.homedir(), '.local', 'share', 'briefkit', 'responses');
}

export function validResponseId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

export async function saveLocalResponse(revisionId: string, submission: BriefkitSubmission, ip?: string): Promise<StoredResponse> {
  const directory = path.join(localResponseRoot(), revisionId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const record: StoredResponse = {
    submissionId: crypto.randomBytes(16).toString('hex'),
    receivedAt: new Date().toISOString(),
    revisionId,
    submission,
    ...(ip ? { ip } : {}),
  };
  await fs.writeFile(path.join(directory, `${record.submissionId}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}

export async function readLocalResponses(revisionId: string): Promise<StoredResponse[]> {
  if (!validResponseId(revisionId)) throw new Error('Response ID must be a 32-character hexadecimal ID.');
  const directory = path.join(localResponseRoot(), revisionId);
  const entries = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records: StoredResponse[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}\.json$/.test(entry)) continue;
    records.push(JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8')) as StoredResponse);
  }
  return records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.submissionId.localeCompare(b.submissionId));
}
