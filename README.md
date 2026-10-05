# buildstats

Build in public without giving away your work. buildstats reads the logs your AI coding agents and git already keep on your machine and turns them into a small JSON summary: sessions, prompts, hours, commits, lines changed and tokens, by month and by week, grouped by sector and type of work.

The summary never contains prompts, code, file paths, project names or repo names. You decide the sector names; everything else is a count.

See it running: [kessdaniel.com/build](https://kessdaniel.com/build.html)

## What it reads

| Source | Where | What it gives |
| --- | --- | --- |
| Claude Code session logs | `~/.claude/projects/**/*.jsonl` | Tokens, models, tool use (type of work), agent hours, sessions, sub-agent runs |
| Claude Code prompt history | `~/.claude/history.jsonl` | Prompts, sessions and hours at the keyboard, further back than the session logs |
| ZCode | `~/.zcode/cli/rollout/*.jsonl` | Tokens and models |
| git | every repo directly under your `gitRoots` | Commits and lines changed by your author emails, and which commits an AI agent co-wrote |

Claude Code deletes session logs after about 30 days by default. buildstats keeps its own history in `~/.buildstats/history.json`, so once a month has been counted it stays counted. To keep more raw logs, raise `cleanupPeriodDays` in your Claude Code settings.

## Quick start

Requires Node 18 or later. No dependencies.

```sh
git clone https://github.com/iamkessdaniel/buildstats
mkdir -p ~/.buildstats
cp buildstats/config.example.json ~/.buildstats/config.json   # then edit it
node buildstats/collect.mjs --out stats.json                   # look before you publish
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

## Parallel time

Agents let you work in parallel: several sessions and sub-agents can run at once. buildstats counts every active minute once on the clock (`clockHours`) and once per stream that was working (`parallelHours`). `parallelFactor` is the ratio, the average number of streams running per clock hour, and `peakParallel` is the most that ran in the same minute.

## Type of work

Each model call is classed by the tools it used: file edits are Building (Writing for Markdown and text files), deploy commands are Shipping, test and type-check commands are Testing, reads and searches are Research, and calls with no tools are Planning.

## Publishing

`node collect.mjs --publish` POSTs the summary as JSON with `Authorization: Bearer <token>`. Any endpoint that stores the body and serves it back works. Run it daily with cron or launchd.

The output schema is `buildstats/2`: `totals`, `coverage` (the first month each metric exists), `months[]` and `weeks[]`.

## Licence

MIT
