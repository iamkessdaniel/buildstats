# buildstats

Build in public without giving away your work. buildstats reads the logs your AI coding agents and git already keep on your machine and turns them into a small JSON summary: sessions, prompts, hours, commits, lines changed and tokens, by month and by week, grouped by sector and type of work.

The summary never contains prompts, code, file paths, project names or repo names. You decide the sector names; everything else is a count.

See it running: [kessdaniel.com/build](https://kessdaniel.com/build) · Method: [AI PTM v1.0, DOI 10.5281/zenodo.23173765](https://doi.org/10.5281/zenodo.23173765)

## What it reads

| Source | Where | What it gives |
| --- | --- | --- |
| Claude Code session logs | `~/.claude/projects/**/*.jsonl` | Tokens, models, tool use (type of work), agent hours, sessions, sub-agent runs |
| Claude Code prompt history | `~/.claude/history.jsonl` | Prompts, sessions and hours at the keyboard, further back than the session logs |
| ZCode | `~/.zcode/cli/rollout/*.jsonl` | Tokens and models |
| Codex local sessions | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl` | Tokens, models, tools, sessions, prompts and parallel time |
| Gemini CLI | `~/.gemini/tmp/**/session-*.json` and `session-*.jsonl`; older `logs.json` | Recorded tokens, models, tools, sessions and prompts; older prompt-only records have no token estimates |
| Instrumented Gemini API callers | `~/.buildstats/gemini-usage.jsonl` | Response usage, models, request duration and invocation counts; no request or response content |
| git | every repo directly under your `gitRoots` | Commits and lines changed by your author emails, and which commits an AI agent co-wrote |

Claude Code deletes session logs after about 30 days by default. buildstats keeps its own history in `~/.buildstats/history.json`, so once a month has been counted it stays counted. To keep more raw logs, raise `cleanupPeriodDays` in your Claude Code settings.

## Quick start

Requires a supported Node.js LTS release; tested with Node 24.22.1. No dependencies.

```sh
git clone https://github.com/iamkessdaniel/buildstats
mkdir -p ~/.buildstats
cp buildstats/config.example.json ~/.buildstats/config.json   # then edit it
node buildstats/collect.mjs --out stats.json                   # look before you publish
node buildstats/collect.mjs --dry-run --out preview.json       # also leaves saved history untouched
```

## Config

`~/.buildstats/config.json` stays on your machine.

- `since`: the first date to count from.
- `authors`: your git author emails. Commits by anyone else are ignored.
- `gitRoots`: folders whose direct sub-folders are git repos.
- `sectors`: your own names for groups of projects, each with the folders that belong to it. A turn is placed in the sector of the files and commands it touched, then the working folder, then the last sector that session worked on.
- `unassigned`: the sector for work that matches none of the above.
- `idleMinutes` / `keyboardIdleMinutes`: gaps longer than this do not count towards agent hours or hours at the keyboard.
- `publish`: where `--publish` sends the summary, and the bearer token it sends.
- `codexDirs`: optional list of session folders, overriding the default active and archived Codex folders.
- `geminiDir`: optional Gemini CLI temporary/session folder.
- `geminiUsageFile`: optional metadata-only Gemini API ledger path.

## Gemini API usage capture

The CLI collector needs no wrapper. To capture future calls from an existing local `~/bin/gemini-copy` helper, run:

```sh
python3 integrations/instrument-gemini-copy.py
```

The installer recognises the helper's response block, saves a backup, adds usage capture, and copies the standard-library Python and JavaScript writers into `~/.buildstats/`. It makes no API calls. Repeating the installer does not add a second hook. Usage capture failures produce a warning without changing generated copy.

Other local API callers must call the matching writer after decoding each response. Python callers can import `record_usage` from `integrations/gemini_usage.py`; JavaScript callers can import `recordGeminiUsage` from `integrations/gemini-usage.mjs`. Pass the decoded response, model, and request start timestamp. Both writers accept an optional work category and ledger destination, and whitelist numeric usage fields. Ledger files are owner-readable/writable only. Cached input is already part of input; Gemini thoughts count as output. Provider total tokens are used once.

The API ledger contains one invocation per local request, not keyboard activity. Each invocation is a separate stream with its measured request duration. It is grouped into the configured unassigned sector because the ledger excludes working directories. Browser chats, remote agents, other machines and uninstrumented API callers are outside this collector's coverage. Missing historical API usage cannot be reconstructed from generated text.

Codex per-response usage records take precedence over legacy UI counters in files containing both; older files use cumulative deltas with repeated counter snapshots skipped. Migrated Gemini chat files and repeated message updates are deduplicated by session and message ID. Recorded spend is retained when an append-only Gemini log later rewinds its visible conversation.

## Parallel time (AI PTM)

Agents let you work in parallel: several sessions and sub-agents can run at once. buildstats counts every active minute once on the clock (`clockHours`) and once per stream that was working (`parallelHours`). `parallelFactor` is the ratio, the average number of streams running per clock hour, and `peakParallel` is the most that ran in the same minute.

## Companion metrics

| Field | Meaning |
| --- | --- |
| `delegationRatio` | Agent working hours divided by keyboard hours, in months that have both |
| `autonomySpanMin` | Median agent minutes between one of your prompts and the agent's last call before your next prompt |
| `promptLeverageMin` | Mean agent minutes set off by one prompt |
| `method` | The metric, version and idle cut-off behind every figure: `AI PTM v1.0, tau = 30 min` |

The full AI PTM methodology, including prior art, is at [kessdaniel.com/ai-ptm.html](https://kessdaniel.com/ai-ptm) and on Zenodo: [10.5281/zenodo.23173765](https://doi.org/10.5281/zenodo.23173765).

## Type of work

Each model call is classed by the tools it used: file edits are Building (Writing for Markdown and text files), deploy commands are Shipping, test and type-check commands are Testing, reads and searches are Research, and calls with no tools are Planning.

## Publishing

`node collect.mjs --publish` POSTs the summary as JSON with `Authorization: Bearer <token>`. Any endpoint that stores the body and serves it back works. Run it daily with cron or launchd.

The output schema is `buildstats/4`: `totals`, `coverage` (the first month each metric exists), `months[]` and `weeks[]`. `sourceCoverage` reports fresh-log calls, measured calls, prompts, tokens, date ranges, missing usage, prompt-only records and invalid records for Codex and Gemini. Known activity timestamps are kept even when a record lacks token usage; its tokens contribute zero and its missing-usage count makes the gap explicit. These diagnostics describe logs present on this run; retained monthly history may extend further back. Missing sources and missing usage are never estimated. `--dry-run` refuses publishing, profile updates and board/entry submissions.

Run the offline regression checks with `node --test test/agent-sources.test.mjs`.

## GitHub profile card

`node collect.mjs --profile` rewrites the block between `<!-- buildstats:start -->` and `<!-- buildstats:end -->` in a local clone of your profile README, then commits and pushes it. Set `profile.repo` to the clone's folder, and optionally `profile.dashboard` to link your full dashboard. Keep the clone outside your `gitRoots`, so its daily commits are not counted as work.

## Licence

MIT
