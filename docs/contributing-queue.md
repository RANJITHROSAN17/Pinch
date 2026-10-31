# The contributor queue

Pinch keeps a **small** number of fully specified `good first issue` tasks open, and a bot keeps it
stocked from a manifest a human reviewed. This document is the human side of that loop.

## Why small

An open issue is a promise that someone will answer. Nine bot-filed proposals with zero human
replies reads as an abandoned project with a bot talking to itself — and it buries the three tasks
a newcomer could actually finish tonight. The cap is three open `difficulty/easy` issues. Overflow
lives in `.github/roadmap.json` with `"status": "backlog"` and is invisible to the bot.

## The loop

```
you edit roadmap.json  →  PR review  →  merge  →  bot files ONE issue  →  you reply  →  they PR
        ↑                                                                       ↓
        └───────────────── status: shipped, credit in the release ──────────────┘
```

1. **Propose.** Add an entry to `.github/roadmap.json` with `status: "backlog"` and open a normal
   PR. Nothing is filed from `backlog`.
2. **Specify.** Move it to `status: "ready"` only when the body has all four sections:
   `## Context`, `## Acceptance criteria`, `## How to verify`, `## Time estimate`. CI runs
   `scripts/validate-roadmap.js` and **fails the PR** if any is missing, or if the body does not
   name a file, or if there are more than three `easy` candidates. You cannot merge a
   half-specified task, which is the entire point.
3. **File.** The weekly (hourly-checked, cap-gated) workflow files the first eligible item with a
   hidden `<!-- roadmap:ID -->` marker and a footer naming you and your reply SLA.
4. **Answer.** Reply within the SLA stated in `meta.reply_sla_hours`. If you cannot, set
   `"status": "backlog"` and close with a note — a closed, honestly-parked issue is better than an
   open one nobody answers.
5. **Ship.** Set `"status": "shipped"`. The bot comments the release name and closes **only**
   issues it created itself; it refuses to touch anything a human opened.

## Rules the bot enforces in code, not in a prompt

| Rule | Where |
|---|---|
| Never improvises what to file | reads `roadmap.json` only; no model at runtime |
| Re-running is a no-op | searches for `<!-- roadmap:ID -->` before creating |
| One issue per run, cap 3 | `meta.open_easy_cap` + the queue count step |
| Refuses incomplete issues | `scripts/validate-roadmap.js` (CI gate) |
| Cannot touch human work | author check before any comment/close |
| Least privilege | `contents: read`, `issues: write` only |
| No PR comments | the workflow never calls `gh pr comment` |
| No injection | manifest strings reach the shell via `env:` + `"$VAR"` only |

## Running it by hand

```bash
node scripts/validate-roadmap.js .github/roadmap.json     # same gate CI uses
gh workflow run contributor-queue.yml -f dry_run=true     # report, change nothing
```

After the first week of `dry_run: true`, flip the schedule to live by dispatching with
`dry_run=false`.

## If the two bot loops collide

`scripts/growth.js` also files issues (label `growth`). Two filing loops means two queues and a
breached cap. Pick one:

- **Narrow `growth.js` to research + annotate only** (recommended), so all issue creation flows
  through this reviewed manifest; or
- count `label:growth` toward the same cap in the `Count the open curated queue` step.
