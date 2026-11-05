import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectAdditional } from '../agent-sources.mjs';
import { recordGeminiUsage } from '../integrations/gemini-usage.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildstats-test-'));
const ts = '2026-11-05T10:00:00Z';
function fixture(name, entries, config = {}) {
  const home = path.join(root, name); fs.mkdirSync(home, { recursive: true });
  for (const [f, rows] of Object.entries(entries)) {
    const p = path.join(home, f); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof rows === 'string' ? rows : rows.map((r) => JSON.stringify(r)).join('\n'));
  }
  return { home, dir: path.join(home, '.buildstats'), since: Date.parse('2026-11-01'), config,
    sectorOf: (cwd) => cwd === '/fixture/shop' ? 'Commerce' : 'Other', touchedSector: () => null };
}
const row = (type, payload, timestamp = ts) => ({ type, payload, timestamp });
const meta = (id = 'session1', source = 'cli') => row('session_meta', { id, cwd: '/fixture/shop', source });
const context = row('turn_context', { model: 'gpt-6.1-sol', cwd: '/fixture/shop' });
const usage = (total = 110, output = 10) => ({ input_tokens: total - output, cached_input_tokens: 80,
  output_tokens: output, reasoning_output_tokens: 4, total_tokens: total });

test('Codex modern/legacy pairs, replayed copies and repeated response IDs count once', () => {
  const rows = [meta(), context, row('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' }),
    row('token_usage_record', { response_id: 'resp1', usage: usage(), thread_token_usage: usage() }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: usage(), total_token_usage: usage() } }),
    row('token_usage_record', { response_id: 'resp1', usage: usage(), thread_token_usage: usage() })];
  const d = collectAdditional(fixture('codex-modern', { '.codex/sessions/a.jsonl': rows, '.codex/archived_sessions/a.jsonl': rows }));
  assert.equal(d.events.length, 1); assert.equal(d.events[0].tokens, 110); assert.equal(d.events[0].output, 10);
  assert.equal(d.events[0].tools[0].name, 'Bash'); assert.equal(d.events[0].tools[0].input.command, 'npm test');
  assert.equal(d.events[0].sector, 'Commerce'); assert.equal(d.events[0].model, 'gpt-6.1-sol');
});

test('legacy Codex cumulative deltas handle unchanged counters, cutoffs and resets', () => {
  const token = (n, out, when) => row('event_msg', { type: 'token_count', info: { total_token_usage: usage(n, out), last_token_usage: usage(110, 10) } }, when);
  const rows = [meta(), context, token(110, 10, '2026-10-31T23:59:00Z'), token(220, 20, ts), token(220, 20, ts), token(110, 10, '2026-11-05T10:02:00Z')];
  const d = collectAdditional(fixture('codex-legacy', { '.codex/sessions/a.jsonl': rows }));
  assert.equal(d.events.length, 2); assert.equal(d.events.reduce((s, e) => s + e.tokens, 0), 220);
});

test('Codex compaction counters and replayed last usage cannot inflate response records', () => {
  const rows = [meta(), context,
    row('token_usage_record', { response_id: 'compaction', usage: usage(), thread_token_usage: usage(900, 100) }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: usage(), total_token_usage: usage(800, 90) } }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 38470, input_tokens: 0, output_tokens: 0 }, total_token_usage: usage(1200, 90) } }),
  ];
  const d = collectAdditional(fixture('codex-compaction', { '.codex/sessions/a.jsonl': rows }));
  assert.equal(d.events.length, 1); assert.equal(d.events[0].tokens, 110);
});

test('Codex prompts exclude injected context; native user events take precedence', () => {
  const user = (id, text) => row('response_item', { type: 'message', role: 'user', id, content: [{ text }] });
  const d = collectAdditional(fixture('codex-prompts', {
    '.codex/sessions/a.jsonl': [meta(), user('agents', '# AGENTS.md instructions'), user('env', '<environment_context>x</environment_context>'), user('real', 'Build the fixture')],
    '.codex/sessions/b.jsonl': [meta('session2'), user('duplicate', 'Build'), row('event_msg', { type: 'user_message', message: 'Build' })],
  }));
  assert.equal(d.prompts.length, 2);
});

test('Codex child sessions are separate parallel streams', () => {
  const d = collectAdditional(fixture('codex-child', { '.codex/sessions/a.jsonl': [meta('child', { subagent: { thread_spawn: {} } }), context,
    row('token_usage_record', { response_id: 'child1', usage: usage() })] }));
  assert.equal(d.events[0].sub, true);
});

test('Gemini JSON and migrated JSONL message updates count usage and prompts once', () => {
  const metadata = { sessionId: 'gemini1', directories: ['/fixture/shop'] };
  const user = { id: 'u1', timestamp: ts, type: 'user', content: 'PRIVATE_FIXTURE_PROMPT' };
  const response = { id: 'r1', timestamp: ts, type: 'gemini', model: 'gemini-3-flash-preview', content: 'PRIVATE_FIXTURE_RESPONSE',
    tokens: { input: 100, cached: 80, output: 10, thoughts: 5, tool: 2, total: 117 }, toolCalls: [{ name: 'write_file', args: { file_path: '/fixture/shop/file.js' } }] };
  const d = collectAdditional(fixture('gemini-migrate', {
    '.gemini/tmp/hash/chats/session-a.json': JSON.stringify({ ...metadata, messages: [user, response] }),
    '.gemini/tmp/hash/chats/session-a.jsonl': [metadata, user, { ...response, tokens: undefined }, response, response],
    '.gemini/tmp/hash/logs.json': JSON.stringify([{ sessionId: 'gemini1', messageId: 'u1', timestamp: ts, type: 'user', message: 'PRIVATE_FIXTURE_PROMPT' }]),
  }));
  assert.equal(d.events.length, 1); assert.equal(d.events[0].tokens, 117); assert.equal(d.events[0].output, 15);
  assert.equal(d.prompts.length, 1); assert.equal(d.events[0].tools[0].name, 'Write');
  assert.equal(d.sources['Gemini CLI'].promptOnlyRecords, 0);
  assert.ok(!JSON.stringify(d.sources).includes('PRIVATE_FIXTURE'));
});

test('Gemini missing usage and prompt-only legacy history stay visible without invented tokens', () => {
  const d = collectAdditional(fixture('gemini-missing', {
    '.gemini/tmp/hash/chats/session-a.json': JSON.stringify({ sessionId: 'g', messages: [{ id: 'r', type: 'gemini', timestamp: ts, content: 'x' }] }),
    '.gemini/tmp/hash/logs.json': JSON.stringify([{ sessionId: 'old', messageId: 'u', type: 'user', timestamp: ts, message: 'x' }]),
  }));
  assert.equal(d.events.length, 1); assert.equal(d.events[0].tokens, 0); assert.equal(d.events[0].usageMissing, true); assert.equal(d.prompts.length, 1);
  assert.equal(d.sources['Gemini CLI'].measuredCalls, 0);
  assert.equal(d.sources['Gemini CLI'].missingUsage, 1); assert.equal(d.sources['Gemini CLI'].promptOnlyRecords, 1);
});

test('Gemini ledger uses total once, includes thought output, rejects malformed rows', () => {
  const r = { schema: 'buildstats-gemini/1', id: 'api1', timestamp: ts, startedAt: '2026-11-05T09:59:00Z', model: 'gemini-3.1-pro-preview', work: 'Writing',
    usage: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 } };
  const d = collectAdditional(fixture('gemini-api', { '.buildstats/gemini-usage.jsonl': [r, r, { ...r, id: 'api2', usageMissing: true }, { schema: 'wrong' }] }));
  assert.equal(d.events.length, 2); assert.equal(d.prompts.length, 2); assert.equal(d.events[0].tokens, 115);
  assert.equal(d.sources['Gemini API'].measuredCalls, 1); assert.equal(d.events[1].tokens, 0);
  assert.equal(d.events[0].output, 15); assert.equal(d.events[0].work, 'Writing'); assert.ok(d.events[0].startTs < d.events[0].ts);
  assert.equal(d.sources['Gemini API'].missingUsage, 1); assert.equal(d.sources['Gemini API'].invalidRecords, 1);
});

test('writer whitelists usage, restricts permissions, and appends concurrently without API calls', () => {
  const ledger = path.join(root, 'writer', 'ledger.jsonl');
  const module = new URL('../integrations/gemini_usage.py', import.meta.url).pathname;
  const script = `import runpy,sys,concurrent.futures\nm=runpy.run_path(sys.argv[1])\nbody={"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":80,"candidatesTokenCount":10,"thoughtsTokenCount":5,"SECRET_FIXTURE":999},"candidates":[{"text":"SECRET_FIXTURE"}]}\nwith concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:\n list(pool.map(lambda _:m['record_usage'](body,'gemini-fixture',ledger=sys.argv[2]),range(40)))\n`;
  execFileSync('python3', ['-c', script, module, ledger]);
  const text = fs.readFileSync(ledger, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 40); assert.equal(new Set(rows.map((r) => r.id)).size, 40);
  assert.equal(rows[0].usage.totalTokenCount, 115); assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
  assert.ok(!text.includes('SECRET_FIXTURE'));
});

test('JavaScript writer uses the shared schema, marks absent usage, and refuses symlinks', () => {
  const ledger = path.join(root, 'js-writer', 'ledger.jsonl');
  const row = recordGeminiUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5,
    cachedContentTokenCount: 80, SECRET_FIXTURE: 99 }, candidates: [{ content: 'SECRET_FIXTURE' }] }, 'gemini-fixture', ts, { ledger, work: 'Writing' });
  assert.equal(row.usage.totalTokenCount, 115); assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
  assert.equal(recordGeminiUsage({}, 'gemini-fixture', ts, { ledger }).usageMissing, true);
  assert.ok(!fs.readFileSync(ledger, 'utf8').includes('SECRET_FIXTURE'));
  const symlink = path.join(root, 'js-writer', 'symlink.jsonl'); fs.symlinkSync(ledger, symlink);
  assert.throws(() => recordGeminiUsage({}, 'gemini-fixture', ts, { ledger: symlink }));
});

test('collector dry-run integrates adapters, preserves history, and exports only aggregates', () => {
  const f = fixture('integration', { '.codex/sessions/a.jsonl': [meta(), context,
    row('response_item', { type: 'message', role: 'user', id: 'prompt', content: [{ text: 'SECRET_FIXTURE_PROMPT' }] }),
    row('token_usage_record', { response_id: 'integration', usage: usage() })] });
  fs.mkdirSync(f.dir);
  const config = { since: '2026-11-01', gitRoots: [], claudeDir: path.join(f.home, 'empty'), zcodeDir: path.join(f.home, 'empty'),
    historyFile: path.join(f.home, 'empty'), codexDirs: [path.join(f.home, '.codex/sessions')], geminiDir: path.join(f.home, '.gemini'),
    sectors: [{ name: 'Commerce', paths: ['/fixture/shop'] }] };
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(config));
  const history = '{"months":{},"weeks":{}}'; fs.writeFileSync(path.join(f.dir, 'history.json'), history);
  const cli = new URL('../collect.mjs', import.meta.url).pathname;
  const s = execFileSync('node', [cli, '--dry-run'], { env: { ...process.env, BUILDSTATS_HOME: f.dir }, encoding: 'utf8' });
  const d = JSON.parse(s); assert.equal(d.totals.tokens, 110); assert.equal(d.totals.prompts, 1);
  assert.equal(d.months[0].agents.Codex, 110); assert.equal(d.sourceCoverage.Codex.calls, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'history.json'), 'utf8'), history);
  for (const secret of ['SECRET_FIXTURE', '/fixture/', 'response_id', 'input_tokens', 'session1']) assert.ok(!s.includes(secret), secret);
  const denied = spawnSync('node', [cli, '--dry-run', '--publish'], { env: { ...process.env, BUILDSTATS_HOME: f.dir } });
  assert.notEqual(denied.status, 0);
});

test('installer is idempotent; instrumented gemini-copy preserves stdout and records usage offline', () => {
  const f = fixture('helper', {}), bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
  const helper = `#!/usr/bin/env bash\npython3 - "$KEY" "$MODEL" "$SYSTEM" "$BRIEF" "$TEMP" <<'PY'\nimport json, sys, urllib.request, urllib.error\nkey, model, system, brief, temp = sys.argv[1:6]\nreq = urllib.request.Request('https://fixture.invalid', data=b'{}')\ntry:\n    body = json.load(urllib.request.urlopen(req, timeout=120))\nexcept urllib.error.HTTPError as e:\n    sys.exit('api error')\n\ntry:\n    cand = body["candidates"][0]\n    text = "".join(p.get("text", "") for p in cand["content"]["parts"])\nexcept (KeyError, IndexError):\n    sys.exit('no output')\nprint(text.strip())\nPY\n`;
  const target = path.join(bin, 'gemini-copy'); fs.writeFileSync(target, helper, { mode: 0o755 });
  const installer = new URL('../integrations/instrument-gemini-copy.py', import.meta.url).pathname;
  execFileSync('python3', [installer, '--home', f.home]);
  const once = fs.readFileSync(target, 'utf8');
  execFileSync('python3', [installer, '--home', f.home]);
  assert.equal(fs.readFileSync(target, 'utf8'), once); assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.readdirSync(path.join(f.home, '.buildstats/backups')).length, 1);
  const script = `import pathlib,sys,io,json,os\nfrom unittest.mock import patch\np=pathlib.Path(sys.argv[1]);home=pathlib.Path(sys.argv[2]);code=p.read_text().split("<<'PY'\\n",1)[1].rsplit('\\nPY',1)[0]\nbody={'usageMetadata':{'promptTokenCount':100,'candidatesTokenCount':10,'totalTokenCount':110},'candidates':[{'content':{'parts':[{'text':'Fixture copy'}]}}]}\nos.environ['BUILDSTATS_HOME']=str(home/'.buildstats')\nwith patch.object(pathlib.Path,'home',return_value=home), patch('urllib.request.urlopen',return_value=io.StringIO(json.dumps(body))):\n sys.argv=['gemini-copy','fake-key','gemini-fixture','system','PRIVATE_FIXTURE_BRIEF','0.7']\n exec(compile(code,'gemini-copy','exec'),{})\n`;
  const stdout = execFileSync('python3', ['-c', script, target, f.home], { encoding: 'utf8' });
  assert.equal(stdout, 'Fixture copy\n');
  const text = fs.readFileSync(path.join(f.home, '.buildstats/gemini-usage.jsonl'), 'utf8');
  assert.equal(JSON.parse(text).usage.totalTokenCount, 110); assert.ok(!text.includes('PRIVATE_FIXTURE')); assert.ok(!text.includes('fake-key'));
});
