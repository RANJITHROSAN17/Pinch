# How this repository grows

Pinch improves on a loop that runs every day: **a machine looks, a human
decides, whoever is free builds.** This page documents the machine part, so that
when it files something odd you can point at the rule it broke.

```text
05:41 UTC daily  ◄─ .github/workflows/growth.yml ─┐
                                                  │
      scripts/growth.js measures the checkout ────┤
                                                  │
        ┌─────────────┬─────────────────┬─────────┴────────┐
        │             │                 │                  │
     "file it"   "annotate it"      "stay quiet"        paused by
        │             │                 │            .github/growth-pause
   one issue   a spec comment      the normal case
```

## What it looks at

Every signal is measured from the checkout in front of it. No model, no network
call, no API key — the job runs in about two minutes and a maintainer can
reproduce any decision with one command.

| Signal | How it is measured | Why it matters |
| --- | --- | --- |
| **A human asked** | open issues that are not labelled `growth`, `security` or `dependencies` | The only input that cannot be invented. Scored highest. |
| **Test coverage** | `node --test --experimental-test-coverage`, parsed | The one number that cannot be argued with. Files below 60% with 40+ lines become candidates; files absent from the report entirely are called out as *unloaded*, which is a stronger statement than a low percentage. |
| **Undocumented configuration** | env vars read by `src/` and absent from `.env.example` and the guides | A switch nobody can find is a feature nobody has. |
| **CLI drift** | verbs in `usage()` vs `case` labels in `bin/pinch.js` | The help text is a promise. Aliases (`case "start": case "serve":`) are grouped, not double-counted. |
| **Broken documentation links** | relative links in the markdown files | A 404 at the moment someone is being careful. |
| **Residual risks** | the register in [`AUDIT.md`](AUDIT.md) | Included so they are visible, scored deliberately low: they were *decided*. Re-proposing a decision daily is how a bot gets muted. |

## The gate — what "when needed" actually means

The bot is silent by default. It speaks only when all of these hold:

1. the best candidate scores **at least 3** (`impact × confidence × demand ÷ effort`);
2. **fewer than 2** growth proposals are already open — a full backlog is a
   signal to build, not a signal to file more;
3. the same **fingerprint** has not been proposed in the last **30 days**, in any
   state. A closed proposal is a "not now", not a "never": after the window it
   can come back.

At most **one issue per run**, ever. There is no "batch" mode, because a bot
that files five things a day is a bot you stop reading.

## Two outcomes that are not "file an issue"

**Annotate.** When the top candidate is a request a human already opened, the
bot comments a spec on that issue instead of filing a duplicate: where the change
lands, what it costs, which invariant it could touch, and the test that would
prove it works. It says plainly that it is speculation, not a promise.

**Quiet.** Most days. A silent run is a passing run — the job exits 0 and records
the ranked table in the run summary so you can see what it *would* have said.

## Killing it, or telling it to wait

| Want | Do |
| --- | --- |
| Stop it for a while | `touch .github/growth-pause` — the file's contents are printed in the run log as the reason. Delete it to resume. |
| Stop it permanently | Delete `.github/workflows/growth.yml`. `scripts/growth.js` is still usable by hand. |
| See what it would do today | `npm run growth` (report, no side effects) |
| Same, machine readable | `node scripts/growth.js --json` |
| Use a different bar | `--min 4`, `--max-open 1`, `--window 60` |
| Reproduce a past run | `--today 2026-10-30` — the date is an input, not an ambient fact |

## Why there is no model in this loop

This is the part that looks like a missed opportunity, so it is worth stating
plainly.

A model asked *"what feature should we build next?"* with no inputs answers from
its training data — confidently, and about a year out of date. That is precisely
the failure Pinch's own honesty guard exists to catch, and committing it in the
repository that ships the guard would be a bad joke.

The alternative — a model with tools, reading the repo, opening a PR every
morning — was considered and rejected in
[`.github/prompts/self-improvement.md`](../.github/prompts/self-improvement.md).
The short version: this repository runs shell commands on someone's laptop. A
subtle change to `screenCommand()` or `resolveInWorkspace()` does not produce a
broken button; it produces a machine that can be wiped by a prompt injection. A
human reads changes in that path, every time — and a weekly bot PR is a weekly
decision you learn to ignore.

So the machine gathers facts, and stops. The judgement stays where the blast
radius is.

## If you want to make the loop smarter

The honest answer is that `scripts/growth.js` is deliberately under-powered.
Adding a signal is a small, testable change:

1. write a `collectSomething()` that returns `candidate({...})` objects;
2. give it a stable `fingerprint` — dedupe depends on it being exact;
3. set `confidence: 3` only if the signal is *measured* from the tree, `2` if it
   is read from a document, `1` if you are inferring;
4. add it to the `all` array in `main()`;
5. add a test in `test/growth.test.js` — every collector currently has one, and
   two false positives were caught that way before the bot ever filed anything.

A signal you cannot measure does not belong here. Open an issue instead; that is
the `demand` path, and it is worth more than any heuristic.
