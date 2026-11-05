// Local adapters. Tools and working directories are used locally for grouping;
// only aggregate source diagnostics leave the collector.
import fs from 'node:fs';
import path from 'node:path';

const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const time = (v) => typeof v === 'number' ? v : Date.parse(v);
const modelName = (v) => typeof v === 'string' && /^(gpt-|codex-|gemini-)[a-z0-9._-]+$/i.test(v) ? v : 'unknown';
function files(root, accept, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) files(p, accept, out);
    else if (e.isFile() && accept(e.name)) out.push(p);
  }
  return out.sort();
}
function tool(name = '', value = {}) {
  let input = value;
  if (typeof value === 'string') { try { input = JSON.parse(value); } catch { input = { command: value }; } }
  if (!input || typeof input !== 'object') input = {};
  const short = name.split('.').at(-1);
  const names = { exec_command: 'Bash', shell_command: 'Bash', run_shell_command: 'Bash', exec: 'Bash',
    write_file: 'Write', replace: 'Edit', read_file: 'Read', read_many_files: 'Read', list_directory: 'Glob',
    glob: 'Glob', grep_search: 'Grep', search_file_content: 'Grep', google_web_search: 'WebSearch', web_fetch: 'WebFetch', apply_patch: 'Edit' };
  return { name: names[short] || short, input: { ...input, command: input.command || input.cmd || '',
    file_path: input.file_path || input.path || (typeof value === 'string' && value.match(/\*\*\* (?:Update|Add) File: (.+)/)?.[1]) || '' } };
}

export function collectAdditional({ config, home, dir, since, sectorOf, touchedSector }) {
  const expand = (p) => p.startsWith('~') ? path.join(home, p.slice(1)) : p;
  const events = [], prompts = [], sources = {};
  const seenEvents = new Set(), seenPrompts = new Set();
  const source = (name) => sources[name] ||= { files: 0, calls: 0, measuredCalls: 0, prompts: 0, tokens: 0, promptOnlyRecords: 0, missingUsage: 0, invalidRecords: 0, first: null, last: null };
  function stamp(s, ts) {
    const date = new Date(ts).toISOString();
    if (!s.first || date < s.first) s.first = date;
    if (!s.last || date > s.last) s.last = date;
  }
  function event(key, e) {
    if (!Number.isFinite(e.ts) || e.ts < since || seenEvents.has(key)) return;
    seenEvents.add(key); events.push(e);
    const s = source(e.agent); s.calls++; if (!e.usageMissing) s.measuredCalls++;
    s.tokens += e.tokens; stamp(s, e.ts);
  }
  function prompt(key, p, agent) {
    if (!Number.isFinite(p.ts) || p.ts < since || seenPrompts.has(key)) return false;
    seenPrompts.add(key); prompts.push(p);
    const s = source(agent); s.prompts++; stamp(s, p.ts);
    return true;
  }
  function lines(f, s) {
    return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => {
      if (!l.trim()) return [];
      try { return [JSON.parse(l)]; } catch { s.invalidRecords++; return []; }
    });
  }

  const codex = source('Codex');
  const roots = config.codexDirs || [config.codexDir || '~/.codex/sessions', '~/.codex/archived_sessions'];
  for (const f of new Set(roots.flatMap((r) => files(expand(r), (n) => n.endsWith('.jsonl'))))) {
    codex.files++;
    const rows = lines(f, codex);
    const meta = rows.find((r) => r.type === 'session_meta')?.payload || {};
    const session = `codex:${meta.id || meta.session_id || f}`;
    const sub = typeof meta.source === 'object' && !!meta.source?.subagent;
    // New builds emit both per-response records and legacy UI counters. The UI
    // counter can be revised after compaction and replay old last-usage values.
    // Prefer the authoritative response records for that file, never add both.
    const hasModernUsage = rows.some((r) => r.type === 'token_usage_record' && r.payload?.usage);
    const hasUserEvents = rows.some((r) => r.type === 'event_msg' && r.payload?.type === 'user_message');
    let cwd = meta.cwd, model = 'unknown', tools = [], previous = null;
    for (const r of rows) {
      const p = r.payload || {}, ts = time(r.timestamp);
      if (r.type === 'turn_context') { cwd = p.cwd || cwd; model = modelName(p.model); }
      if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) tools.push(tool(p.name, p.arguments ?? p.input));
      if (r.type === 'event_msg' && p.type === 'user_message') {
        const text = typeof p.message === 'string' ? p.message : '';
        prompt(`${session}:${p.id || r.timestamp}`, { ts, session, sector: sectorOf(cwd), slash: text.trim().startsWith('/') }, 'Codex');
      } else if (!hasUserEvents && r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = (p.content || []).map((c) => c.text || '').join('');
        // These are injected context records, not prompts typed by the user.
        if (!/^\s*(# AGENTS\.md|<environment_context>|<INSTRUCTIONS>)/.test(text)) {
          prompt(`${session}:${p.id || r.timestamp}`, { ts, session, sector: sectorOf(cwd), slash: text.trim().startsWith('/') }, 'Codex');
        }
      }
      let u, key;
      if (r.type === 'token_usage_record' && p.usage) {
        u = p.usage;
        key = `codex:${p.response_id || `${session}:${p.thread_token_usage?.total_tokens}:${r.timestamp}`}`;
      } else if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
        if (hasModernUsage) continue;
        const total = p.info.total_token_usage, last = p.info.last_token_usage;
        if (!total && !last) continue;
        const n = total?.total_tokens;
        const before = previous; previous = total || previous;
        if (Number.isSafeInteger(n) && before?.total_tokens === n) continue;
        u = total && before && n > before.total_tokens
          ? { total_tokens: n - before.total_tokens, output_tokens: Math.max(0, count(total.output_tokens) - count(before.output_tokens)) }
          : last;
        key = `${session}:legacy:${n ?? ''}:${r.timestamp}`;
      }
      if (!u) continue;
      const tokens = Number.isSafeInteger(u.total_tokens) ? count(u.total_tokens) : count(u.input_tokens) + count(u.output_tokens);
      event(key, { ts, agent: 'Codex', model, session, sub, tokens, output: count(u.output_tokens),
        sector: touchedSector(tools) || sectorOf(cwd), tools });
      tools = [];
    }
  }

  const gemini = source('Gemini CLI');
  const geminiRoot = expand(config.geminiDir || '~/.gemini/tmp');
  // One map covers legacy JSON, append-only JSONL, migrated copies and updates.
  const messages = new Map();
  for (const f of files(geminiRoot, (n) => /^session-.*\.jsonl?$/.test(n))) {
    gemini.files++;
    let rows;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      rows = d.messages ? [d, ...d.messages] : [d];
    } catch { rows = lines(f, gemini); }
    let session = `gemini:${f}`, cwd, sub = false;
    for (const r of rows) {
      if (r.sessionId) session = `gemini:${r.sessionId}`;
      if (Array.isArray(r.directories)) cwd = r.directories[0];
      if (r.kind) sub = r.kind === 'subagent';
      // Keep already-spent tokens even if a later rewind removes UI history.
      if (!r.id || !['user', 'gemini'].includes(r.type)) continue;
      const key = `${session}:${r.id}`, old = messages.get(key);
      // Migration copies with no usage must not overwrite a richer record.
      messages.set(key, { ...old, ...r, tokens: r.tokens || old?.tokens, session, cwd: cwd || old?.cwd, sub });
    }
  }
  for (const [key, r] of messages) {
    const ts = time(r.timestamp), sector = sectorOf(r.cwd);
    if (r.type === 'user') {
      const text = typeof r.content === 'string' ? r.content : '';
      if (!r.sub) prompt(key, { ts, session: r.session, sector, slash: text.trim().startsWith('/') }, 'Gemini CLI');
    } else {
      const u = r.tokens || {}, tools = (r.toolCalls || []).map((t) => tool(t.name, t.args));
      event(key, { ts, agent: 'Gemini CLI', model: modelName(r.model), session: r.session, sub: r.sub, usageMissing: !r.tokens,
        tokens: Number.isSafeInteger(u.total) ? count(u.total) : count(u.input) + count(u.output) + count(u.thoughts) + count(u.tool),
        output: count(u.output) + count(u.thoughts), sector: touchedSector(tools) || sector, tools });
      if (!r.tokens && Number.isFinite(ts) && ts >= since) gemini.missingUsage++;
    }
  }
  // Older CLI versions keep prompts only. Deduplicate against chat records.
  const promptTimes = new Set(prompts.filter((p) => p.session.startsWith('gemini:')).map((p) => `${p.session}:${p.ts}`));
  for (const f of files(geminiRoot, (n) => n === 'logs.json')) {
    gemini.files++;
    let rows; try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { gemini.invalidRecords++; continue; }
    if (!Array.isArray(rows)) { gemini.invalidRecords++; continue; }
    for (const r of rows) if (r.type === 'user') {
      const ts = time(r.timestamp), session = `gemini:${r.sessionId || f}`;
      if (promptTimes.has(`${session}:${ts}`)) continue;
      if (prompt(`gemini-old:${session}:${r.messageId || r.timestamp}`, { ts, session, sector: sectorOf(null), slash: typeof r.message === 'string' && r.message.trim().startsWith('/') }, 'Gemini CLI')) gemini.promptOnlyRecords++;
    }
  }

  const api = source('Gemini API');
  const ledger = expand(config.geminiUsageFile || path.join(dir, 'gemini-usage.jsonl'));
  if (fs.existsSync(ledger)) {
    api.files++;
    for (const r of lines(ledger, api)) {
      if (r.schema !== 'buildstats-gemini/1' || typeof r.id !== 'string') { api.invalidRecords++; continue; }
      const ts = time(r.timestamp), startTs = time(r.startedAt), session = `gemini-api:${r.id}`;
      if (r.usageMissing && Number.isFinite(ts) && ts >= since) api.missingUsage++;
      if (!r.usage && !r.usageMissing) { api.invalidRecords++; continue; }
      const u = r.usageMissing ? {} : (r.usage || {});
      const work = ['Building', 'Writing', 'Shipping', 'Testing', 'Research', 'Planning'].includes(r.work) ? r.work : 'Planning';
      event(session, { ts, startTs: Number.isFinite(startTs) && startTs <= ts ? Math.max(since, startTs) : ts,
        agent: 'Gemini API', model: modelName(r.model), session, sub: false, usageMissing: !!r.usageMissing, tokens: count(u.totalTokenCount),
        output: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount), sector: sectorOf(null), work, tools: [] });
      prompt(session, { ts: Number.isFinite(startTs) ? startTs : ts, session, sector: sectorOf(null), slash: false }, 'Gemini API');
    }
  }
  return { events, prompts, sources };
}
