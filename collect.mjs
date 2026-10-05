#!/usr/bin/env node
/*
 * buildstats: turn your AI coding sessions and git history into anonymous
 * weekly build-in-public stats.
 *
 * Reads local logs only (Claude Code, ZCode, git). Writes a JSON summary with
 * totals per ISO week, grouped by sector and by type of work. Never includes
 * prompts, code, file paths, project or repo names.
 *
 *   node collect.mjs                 # print the summary
 *   node collect.mjs --out stats.json
 *   node collect.mjs --publish       # POST to config.publish.url
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const DIR = process.env.BUILDSTATS_HOME || path.join(HOME, '.buildstats');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const config = loadConfig();
const IDLE_MS = (config.idleMinutes ?? 10) * 60000;
const SINCE = config.since ? Date.parse(config.since) : Date.now() - (config.weeks ?? 26) * 7 * 864e5;

function loadConfig() {
  const f = path.join(DIR, 'config.json');
  if (!fs.existsSync(f)) return { sectors: [], gitRoots: [path.join(HOME, 'Projects')], authors: [] };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ---------- helpers ----------
function isoWeek(ts) {
  const d = new Date(ts); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
function expand(p) { return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p; }
const SECTORS = (config.sectors || []).map((s) => ({ name: s.name, prefixes: s.paths.map(expand) }))
  .sort((a, b) => Math.max(...b.prefixes.map((p) => p.length)) - Math.max(...a.prefixes.map((p) => p.length)));
function sectorOf(dir) {
  if (!dir) return config.unassigned || 'Other';
  let best = null, len = -1;
  for (const s of SECTORS) for (const p of s.prefixes) if ((dir === p || dir.startsWith(p + '/')) && p.length > len) { best = s.name; len = p.length; }
  return best || config.unassigned || 'Other';
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function readLines(f, fn) {
  const st = fs.statSync(f); if (st.mtimeMs < SINCE) return;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; } fn(o); }
}

// Type of work from the tools a turn used. Order matters: the first match wins.
const DEPLOY = /\b(rsync|docker|kubectl|ssh|scp|systemctl|deploy|compose|helm|terraform|wrangler|vercel|fly)\b/;
const TEST = /\b(test|vitest|jest|pytest|playwright|tsc|lint|eslint|typecheck|cargo check)\b/;
const WRITE_EXT = /\.(md|mdx|txt|rst)$/i;
function workType(tools) {
  if (!tools.length) return 'Planning';
  let t = { build: 0, write: 0, ship: 0, test: 0, research: 0 };
  for (const { name, input } of tools) {
    const cmd = (input && (input.command || '')) + '';
    const file = (input && (input.file_path || input.path || '')) + '';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) WRITE_EXT.test(file) ? t.write++ : t.build++;
    else if (name === 'Bash' && DEPLOY.test(cmd)) t.ship++;
    else if (name === 'Bash' && TEST.test(cmd)) t.test++;
    else if (/^(Read|Grep|Glob|WebSearch|WebFetch|LSP)$/.test(name) || /search|read|fetch/i.test(name)) t.research++;
    else if (/doc|artifact/i.test(name)) t.write++;
    else if (name === 'Bash') t.build++;
  }
  const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  if (!top[1]) return 'Planning';
  return { build: 'Building', write: 'Writing', ship: 'Shipping', test: 'Testing', research: 'Research' }[top[0]];
}

// The project a turn worked on, from paths in its tool inputs.
const PATH_RE = /(?:~|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)\/[^\s'"`;|&>)]+/g;
function touchedSector(tools) {
  const tally = {};
  for (const { input } of tools) {
    if (!input) continue;
    const text = [input.file_path, input.path, input.command, input.notebook_path].filter(Boolean).join(' ');
    for (const m of text.matchAll(PATH_RE)) {
      const s = sectorOf(expand(m[0]));
      if (s !== (config.unassigned || 'Other')) tally[s] = (tally[s] || 0) + 1;
    }
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

// ---------- events ----------
// One event per model call: { ts, agent, model, tokens, output, sector, work, session, sub }
const events = [];

function collectClaudeCode() {
  const root = expand(config.claudeDir || '~/.claude/projects');
  for (const f of walk(root)) {
    const sub = f.includes(`${path.sep}subagents${path.sep}`);
    const seen = new Map(); // requestId -> event (content blocks of one call share usage)
    let cwd = null, last = null; // last: the most recent sector this session touched
    readLines(f, (o) => {
      if (o.cwd) cwd = o.cwd;
      if (o.type !== 'assistant' || !o.message?.usage || !o.timestamp) return;
      const ts = Date.parse(o.timestamp); if (ts < SINCE) return;
      const u = o.message.usage, id = o.requestId || o.uuid;
      const tools = (o.message.content || []).filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input }));
      let e = seen.get(id);
      if (!e) {
        e = { ts, agent: 'Claude Code', model: o.message.model || 'unknown', session: o.sessionId || f, sub,
          tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output: u.output_tokens || 0, sector: null, tools: [] };
        seen.set(id, e); events.push(e);
      }
      e.tools.push(...tools);
      // Sector: a project the tools touched, else the working folder if it is a
      // project, else whatever this session last worked on.
      const touched = touchedSector(tools);
      const here = SECTORS.length && sectorOf(o.cwd || cwd);
      if (touched) last = touched; else if (here && here !== (config.unassigned || 'Other')) last = here;
      e.sector = touched || last || sectorOf(o.cwd || cwd);
    });
  }
}

function collectZCode() {
  const root = expand(config.zcodeDir || '~/.zcode/cli/rollout');
  for (const f of walk(root)) readLines(f, (o) => {
    const u = o.response?.usage; if (!u || !o.completedAt) return;
    const ts = Date.parse(o.completedAt); if (ts < SINCE) return;
    events.push({ ts, agent: 'ZCode', model: o.model?.modelId || 'unknown', session: o.sessionId || f, sub: false,
      tokens: (u.totalTokens || 0) + (u.cacheReadTokens || 0), output: u.outputTokens || 0,
      sector: config.zcodeSector || config.unassigned || 'Other',
      tools: (o.response.toolCalls || []).map((c) => ({ name: c.toolName || c.name || '', input: c.input || c.args })) });
  });
}

function collectGit() {
  const commits = [];
  const authors = config.authors || [];
  const repos = new Set();
  for (const r of (config.gitRoots || []).map(expand)) {
    if (!fs.existsSync(r)) continue;
    for (const e of fs.readdirSync(r, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(r, e.name);
      if (fs.existsSync(path.join(p, '.git'))) repos.add(p);
    }
  }
  const since = new Date(SINCE).toISOString();
  const seenSha = new Set();
  for (const repo of repos) {
    // %x1f separates fields; trailers tell us which commits an AI agent co-wrote.
    const a = ['-C', repo, 'log', '--all', '--no-merges', `--since=${since}`, '--pretty=@%H%x1f%aI%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,separator=;)', '--shortstat'];
    let out; try { out = execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256e6, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) {
        const [sha, date, email, co] = line.slice(1).split('\x1f');
        cur = null;
        if ((authors.length && !authors.includes(email)) || seenSha.has(sha)) continue;
        seenSha.add(sha);
        cur = { ts: Date.parse(date), lines: 0, sector: sectorOf(repo), ai: /claude|anthropic|copilot|cursor|codex|gemini|zcode/i.test((co || '') + ' ' + email) };
        commits.push(cur);
      } else if (cur && line.includes('changed')) {
        const ins = /(\d+) insertion/.exec(line), del = /(\d+) deletion/.exec(line);
        cur.lines = (ins ? +ins[1] : 0) + (del ? +del[1] : 0);
      }
    }
  }
  return commits;
}

// Prompt history (~/.claude/history.jsonl): one line per prompt you typed. It
// outlives the session logs, so it carries sessions and prompts further back.
function collectPrompts() {
  const f = expand(config.historyFile || '~/.claude/history.jsonl');
  const prompts = [];
  if (!fs.existsSync(f)) return prompts;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.timestamp || o.timestamp < SINCE) continue;
    const slash = typeof o.display === 'string' && o.display.trim().startsWith('/');
    prompts.push({ ts: o.timestamp, session: o.sessionId || null, sector: sectorOf(o.project), slash });
  }
  return prompts;
}

// ---------- aggregate ----------
collectClaudeCode();
collectZCode();
const commits = collectGit();
const prompts = collectPrompts();
for (const e of events) e.work = workType(e.tools);

const isoMonth = (ts) => new Date(ts).toISOString().slice(0, 7);
const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
const round = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, typeof v === 'object' ? round(v) : Math.round(v)]));

function aggregate(keyOf, label) {
  const B = {};
  const get = (k) => (B[k] ||= { [label]: k, tokens: 0, output: 0, calls: 0, sessions: new Set(), subagentSessions: new Set(), activeHours: 0,
    prompts: 0, keyboardHours: 0, commits: 0, aiCommits: 0, linesChanged: 0, activeDays: new Set(), agents: {}, models: {}, sectors: {}, work: {}, matrix: {}, promptSectors: {}, commitSectors: {}, lineSectors: {} });
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  for (const e of events) {
    const b = get(keyOf(e.ts));
    b.tokens += e.tokens; b.output += e.output; b.calls++;
    (e.sub ? b.subagentSessions : b.sessions).add(e.session);
    b.activeDays.add(day(e.ts));
    add(b.agents, e.agent, e.tokens); add(b.models, e.model, e.tokens);
    add(b.sectors, e.sector, e.tokens); add(b.work, e.work, e.tokens);
    add((b.matrix[e.sector] ||= {}), e.work, e.tokens);
  }
  for (const p of prompts) {
    const b = get(keyOf(p.ts));
    if (!p.slash) { b.prompts++; add(b.promptSectors, p.sector, 1); }
    if (p.session) b.sessions.add(p.session);
    b.activeDays.add(day(p.ts));
  }
  // Two kinds of hours. Keyboard hours come from your prompts, so they are
  // measured the same way for as far back as prompt history goes. Agent hours
  // come from model calls and exist only where the full session logs survive.
  const gaps = (lists, cut, field) => {
    for (const list of Object.values(lists)) {
      list.sort((a, b) => a - b);
      for (let i = 1; i < list.length; i++) { const g = list[i] - list[i - 1]; if (g > 0 && g <= cut) get(keyOf(list[i]))[field] += g / 36e5; }
    }
  };
  const agentRuns = {}, typed = {};
  for (const e of events) if (!e.sub) (agentRuns[e.session] ||= []).push(e.ts);
  for (const p of prompts) if (p.session) (typed[p.session] ||= []).push(p.ts);
  gaps(agentRuns, IDLE_MS, 'activeHours');
  gaps(typed, (config.keyboardIdleMinutes ?? 30) * 60000, 'keyboardHours');
  for (const c of commits) {
    const b = get(keyOf(c.ts)); b.commits++; if (c.ai) b.aiCommits++; b.linesChanged += c.lines; b.activeDays.add(day(c.ts));
    add(b.commitSectors, c.sector, 1); add(b.lineSectors, c.sector, c.lines);
  }
  return Object.values(B).map((b) => ({
    [label]: b[label], tokens: b.tokens, outputTokens: b.output, modelCalls: b.calls, sessions: b.sessions.size,
    subagentRuns: b.subagentSessions.size, prompts: b.prompts, keyboardHours: Math.round(b.keyboardHours * 10) / 10, agentHours: Math.round(b.activeHours * 10) / 10, activeDays: b.activeDays.size,
    commits: b.commits, aiAssistedCommits: b.aiCommits, linesChanged: b.linesChanged,
    agents: round(b.agents), models: round(b.models), sectors: round(b.sectors), work: round(b.work), matrix: round(b.matrix),
    commitsBySector: round(b.commitSectors), linesBySector: round(b.lineSectors),
  }));
}

// Keep history: logs age out (Claude Code keeps ~30 days by default), so a
// stored bucket is only replaced when the fresh one has at least as much in it.
const histFile = path.join(DIR, 'history.json');
let hist = {}; try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
hist.weeks ||= {}; hist.months ||= {};
const weight = (r) => r.tokens + r.commits + r.prompts * 1000;
function keep(store, rows, label) {
  for (const r of rows) if (!store[r[label]] || weight(r) >= weight(store[r[label]])) store[r[label]] = r;
  return Object.values(store).sort((a, b) => a[label].localeCompare(b[label]));
}
const weeks = keep(hist.weeks, aggregate(isoWeek, 'week'), 'week');
const months = keep(hist.months, aggregate(isoMonth, 'month'), 'month');

// Lifetime figures from distinct sessions and days, not sums of buckets.
const allSessions = new Set([...events.filter((e) => !e.sub).map((e) => e.session), ...prompts.map((p) => p.session).filter(Boolean)]);
const allDays = new Set([...events.map((e) => e.ts), ...prompts.map((p) => p.ts), ...commits.map((c) => c.ts)].map((t) => new Date(t).toISOString().slice(0, 10)));
const firstAi = Math.min(...commits.filter((c) => c.ai).map((c) => c.ts), ...prompts.map((p) => p.ts), ...events.map((e) => e.ts));
const life = hist.lifetime || {};
hist.lifetime = { sessions: Math.max(life.sessions || 0, allSessions.size), activeDays: Math.max(life.activeDays || 0, allDays.size),
  since: new Date(Math.min(firstAi, life.since ? Date.parse(life.since) : Infinity)).toISOString().slice(0, 10) };
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(histFile, JSON.stringify(hist));

const sum = (k) => months.reduce((s, r) => s + (r[k] || 0), 0);
const firstOf = (k) => (months.find((m) => m[k] > 0) || {}).month || null;
const out = {
  schema: 'buildstats/2', generated: new Date().toISOString(), name: config.name || undefined,
  since: hist.lifetime.since,
  coverage: { tokens: firstOf('tokens'), prompts: firstOf('prompts'), aiAssistedCommits: firstOf('aiAssistedCommits'), commits: firstOf('commits'),
    tokenMonths: months.filter((m) => m.tokens > 0).map((m) => m.month) },
  totals: { tokens: sum('tokens'), outputTokens: sum('outputTokens'), sessions: hist.lifetime.sessions, subagentRuns: sum('subagentRuns'),
    prompts: sum('prompts'), keyboardHours: Math.round(sum('keyboardHours')), agentHours: Math.round(sum('agentHours')), activeDays: hist.lifetime.activeDays,
    commits: sum('commits'), aiAssistedCommits: sum('aiAssistedCommits'), linesChanged: sum('linesChanged') },
  months, weeks,
};

const json = JSON.stringify(out, null, 2);
if (opt('--out')) fs.writeFileSync(opt('--out'), json);
if (flag('--publish')) {
  const p = config.publish || {};
  if (!p.url) { console.error('No publish.url in config'); process.exit(1); }
  const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(p.token ? { Authorization: `Bearer ${p.token}` } : {}) }, body: json });
  console.error(`publish: ${r.status}`);
  if (!r.ok) process.exit(1);
}
if (!opt('--out') && !flag('--publish')) console.log(json);
else console.error(`months ${months.length}, weeks ${weeks.length}, tokens ${out.totals.tokens.toLocaleString()}, prompts ${out.totals.prompts}, commits ${out.totals.commits}`);
