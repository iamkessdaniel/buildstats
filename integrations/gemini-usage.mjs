// Response metadata only. No prompts, content, paths or provider response IDs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function recordGeminiUsage(body, model, startedAt, { work = 'Planning', ledger } = {}) {
  const fields = ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount'];
  const usage = Object.fromEntries(Object.entries(body.usageMetadata || {})
    .filter(([k, v]) => fields.includes(k) && Number.isSafeInteger(v) && v >= 0));
  const usageMissing = !Object.keys(usage).length;
  if (!usageMissing && !Object.hasOwn(usage, 'totalTokenCount')) {
    usage.totalTokenCount = ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'].reduce((n, k) => n + (usage[k] || 0), 0);
  }
  const timestamp = new Date().toISOString(), start = Date.parse(startedAt);
  model = body.modelVersion || model;
  const row = { schema: 'buildstats-gemini/1', id: randomUUID(), timestamp,
    startedAt: Number.isFinite(start) && start <= Date.parse(timestamp) ? new Date(start).toISOString() : timestamp,
    model: typeof model === 'string' && /^gemini-[a-z0-9._-]+$/i.test(model) ? model : 'unknown',
    work: ['Building', 'Writing', 'Shipping', 'Testing', 'Research', 'Planning'].includes(work) ? work : 'Planning', usageMissing, usage };
  const target = ledger || path.join(process.env.BUILDSTATS_HOME || path.join(os.homedir(), '.buildstats'), 'gemini-usage.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const data = Buffer.from(JSON.stringify(row) + '\n');
    if (fs.writeSync(fd, data) !== data.length) throw new Error('Incomplete usage record');
  } finally { fs.closeSync(fd); }
  return row;
}
