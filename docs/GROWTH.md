# How this repository grows

Pinch improves on a loop that runs **every hour**: a machine researches and
proposes, a human decides, the machine fixes what is mechanical. This page
documents each part, the rate limit that keeps it from becoming noise, and the
fence that keeps it from becoming dangerous.

Hourly is not the same as "one issue an hour". The loop files only when a
candidate clears the bar, has not been proposed in 30 days, and the board has
room for it. Most runs are quiet, and a quiet run is a passing run — the value
of the hour is that the research is never more than 60 minutes stale.

```text
every hour at :17  ──►  .github/workflows/growth.yml
                       │
    ┌──────────────────┼───────────────────────┐
    │                  │                       │
 1. RESEARCH        2. PROPOSE              3. FIX
 scripts/market.js  scripts/growth.js       scripts/manager.js
    │                  │                       │
 six competitors'   up to a quota of        one mechanical fix,
 READMEs vs our     issues, or a spec       full suite + audit,
 capability list    comment on yours        one PR, human merges
```

Three jobs that already existed stay as they are: the **nightly audit** asks
"do the guard rails still hold?", the **weekly radar** asks "has the ground moved
under us?", and **CodeQL** asks "is any of this code dangerous?". This loop asks
the fourth question: *what should be built next?*

---

## 1. Research — where "compete with the top assistants" actually comes from

`scripts/market.js` fetches the README of **ten** comparable projects and
matches their feature lists against [`CAPABILITIES.json`](CAPABILITIES.json) —
24 capabilities, each with an explicit status, policy and evidence:

| Project | Why it is in the comparison set |
| --- | --- |
| `open-webui/open-webui` | the most-installed local web UI |
| `danny-avila/LibreChat` | closest feature-parity target |
| `Mintplex-Labs/anything-llm` | documents + agents, works offline |
| `lobehub/lobe-chat` | the most-starred assistant UI |
| `janhq/jan` | local-first desktop app |
| `khoj-ai/khoj` | personal assistant with scheduled agents |
| `openinterpreter/open-interpreter` | the code-execution benchmark |
| `mudler/LocalAI` | the drop-in OpenAI-compatible runtime |
| `langgenius/dify` | agent workflows and a plugin market |
| `FlowiseAI/Flowise` | visual agent builder |

The bar is a **share of the set**, not a count: 40% of ten projects, so growing
the comparison set cannot silently lower the standard. A fixed absolute
threshold would have meant something different at six projects than at ten.

The rule that makes this honest: **a competitor claim comes from that
competitor's own documentation, fetched today, quoted with a URL.** Not from a
model's memory of what ChatGPT did in 2024. Every gap in a proposal names which
repos document it and which keywords matched.

Three things the researcher refuses to do:

- **Credit a capability it cannot prove.** An inventory entry marked `have`
  with no evidence is downgraded to `unproven` and treated as absent. A test
  checks that every `have` claim cites a file that exists.
- **Propose against the product's identity.** Every capability carries a
  `policy`: `in-scope`, `settled`, or `out-of-scope`. Multi-user accounts are
  `out-of-scope` — four of six competitors ship them, and it is still not
  backlog, because Pinch is one person on one laptop. A gap the product has
  decided not to close is not a work item.
- **Confuse partial with missing.** A `partial` capability (voice, file upload)
  is usually cheaper to close than a missing one and is scored accordingly.

Run it yourself: `node scripts/market.js`. With `--offline` it reuses the last
snapshot in `docs/market-snapshot.json` instead of the network.

---

## 2. Propose — "as many as needed" is a quota that is earned

`scripts/growth.js` turns measurements and research into proposals. The rate is
not a constant somebody guessed:

| Merged proposals a human accepted | Proposals allowed per hour |
| --- | --- |
| 0–1 | **1** |
| 2–3 | 2 |
| 4–5 | 3 |
| 6–7 | 4 |
| 8+ | **5** (hard cap) |

A loop that has never had a suggestion accepted does not get to open five at
once. One with a track record does not have to be told one at a time. A closed
proposal counts as *no* trust earned — only a merge does.

The board cap is the real throttle: `max(6, quota + 2)` at hourly cadence. Six
open proposals is roughly a week of one maintainer's attention; past that the
loop is producing a queue, not a plan. Nothing is filed while the board is full:
**a full backlog is a signal to build, not to file more.**

### Attention rotates with the hour

An hourly loop that re-sorts the same nine gaps 24 times a day is not more
responsive — it is just faster at saying the same thing. So the hour decides
which class of signal leads:

| UTC hour | Leads with |
| --- | --- |
| 00–05 | what people asked for (open issues) |
| 06–11 | capabilities a human can feel (market-adjacent) |
| 12–17 | capabilities we do not have at all (market gaps) |
| 18–23 | what nothing is testing (coverage) |

The rotation promotes a class by **one place, and only within 20% of the
candidate above it**. Without that guard it becomes a coronation: a score-0.2
gap would outrank a score-9 measurement every time its hour came round. The
shard breaks ties; it does not overrule evidence. `--no-shard` turns it off and
restores straight score order.

Signals it ranks:

| Signal | Measured how | Trust |
| --- | --- | --- |
| **A human asked** | open issues, not labelled `growth`/`security`/`dependencies` | highest — scored 3, and answered with a spec comment rather than a duplicate |
| Test coverage | `node --test --experimental-test-coverage`, parsed | measured |
| Undocumented config | env vars *read* by `src/` and absent from `.env.example` | measured |
| CLI drift | verbs in `usage()` vs `case` labels | measured |
| Broken doc links | relative links that do not resolve | measured |
| Market gaps | the research above | measured, but second-hand: demand 2, not 3 |
| Residual risks | the register in `AUDIT.md` | deliberately low — these were *decided* |

Score is `impact × confidence × demand ÷ effort`, floored at 3.

---

## 3. Fix — the part with a fence around it

`scripts/manager.js` closes the mechanical issues itself and opens a pull
request. Four rules, enforced in code rather than in a prompt:

1. **Paths.** Only `.env.example`, `docs/*.md`, `README.md` and
   `CONTRIBUTING.md` are editable. `src/` is not on the list — not "should not",
   *cannot*. There is no flag that widens it, and a test fails if the allowlist
   ever matches a source file or a traversal.
2. **Fixers.** A file is edited only by a named fixer matching the issue's
   fingerprint. No fixer matches → the manager says "this one needs a person"
   and moves on. It never improvises.
3. **The suite.** Edits are applied, `node --test` and `node scripts/audit.js`
   run, and a red build restores the tree byte for byte. The fix is dropped, not
   debugged unattended.
4. **One at a time.** One fix per run, and the workflow refuses to start if a
   bot PR is already open. A human merges; branch protection makes that a fact.

Currently mechanical: **documenting an undocumented variable** (reading its real
default from `src/config.js`) and **repairing a broken relative link** (retarget
to the file that moved, or demote to plain text if nothing plausible exists).
Everything else stays a proposal, including every market gap — those touch
paths where "the tests passed" is not the same claim as "a human read it".

### Why not let it write features?

This is the honest answer, and it has not changed since the loop was designed
([`.github/prompts/self-improvement.md`](../.github/prompts/self-improvement.md)):

This repository runs shell commands on someone's laptop. A subtle change to
`screenCommand()` or `resolveInWorkspace()` does not produce a broken button; it
produces a machine that can be wiped by a prompt injection. A weekly bot PR is a
weekly decision you learn to ignore — and unreviewed-but-merged automation is how
"we have tests" becomes "we have tests we do not read".

So the machine does the looking, the proposing, and the mechanical fixing. The
judgement stays where the blast radius is.

---

## Turning it down, or off

| Want | Do |
| --- | --- |
| Pause everything | `touch .github/growth-pause` — the file's contents are printed as the reason |
| Hourly is too often | Change the cron in `.github/workflows/growth.yml` to `17 */6 * * *` |
| Propose only, no fix PRs | Run with the `skip_fix` input |
| See what it would do | `npm run growth` (report only) |
| Research only | `node scripts/market.js` |
| Check a fix without applying | `node scripts/manager.js --issues /tmp/issues.json` |
| Different bar / quota | `--min 4`, `--quota 2`, `--window 60`, `--merged 6`, `--hourly-cap 3` |
| See a specific hour's rotation | `--hour 13` (UTC) |
| Reproduce a past run | `--today 2026-10-30` — the date is an input, not ambient fact |

Remove `.github/workflows/growth.yml` to stop the schedule entirely; the three
scripts still work by hand.

## Making the loop smarter

Adding a *signal* is a small, testable change: write a `collectSomething()`
returning `candidate({...})` objects, give it an exact `fingerprint`, set
`confidence: 3` only if it is measured from the tree, register it in `main()`,
and add a test. Two false positives and one silent NaN were caught that way
before the bot ever filed anything.

Adding a *fixer* is a different bar: it must be mechanical (one correct edit,
not a judgement call), it must stay inside the path fence, and it must come with
a test proving the fix and a test proving the refusal.
