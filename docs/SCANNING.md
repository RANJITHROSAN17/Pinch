# What the scanners found, and what happened to each finding

This is the audit trail for the code-scanning alerts on `main` — every alert,
how it was closed, and the four that were dismissed with a reason rather than
fixed. If you are reading this because an alert reappeared: start at
[Re-running the scanners](#re-running-the-scanners).

At the start there were **24 open alerts**: 18 from CodeQL and 6 from OpenSSF
Scorecard. Today there are **zero open**. Of the 18, **16 were closed by
changing code** and **2 were dismissed with the reason written out below** —
neither was a silent pass. Of the 6 Scorecard checks, **2 were fixed by repo
configuration** and **4 dismissed**, because they are about project age, review
history and external badges rather than anything a commit can change.

Fixing these transiently created three more alerts — two on a log line this
pass had just written, one on a line that moved — each fixed in code rather
than waved through. The counts below are the ones that matter, not the story.

## CodeQL: 16 closed in code

Each one was fixed by changing the code, not by loosening the query.

| Rule | Where | What was wrong | Fix |
| --- | --- | --- | --- |
| `js/unused-local-variable` ×5 | `test/agent.test.js`, `scripts/service.js`, `scripts/audit.js`, `src/prompt.js` | dead imports and bindings | removed |
| `js/double-escaping` | `src/tools.js` `decode()` | decoding `&amp;` first meant `&amp;lt;` came back out as `<` — an escape hatch through the sanitiser | decode to a **fixed point**, decode `&amp;` **last**, never decode `&lt;`/`&gt;` |
| `js/incomplete-multi-character-sanitization` | `src/tools.js` | residual `<`/`>` after one pass | same fixed-point loop; a fuzz property now asserts `md()` never emits `<script`, `on*=`, or `javascript:` |
| `js/clear-text-logging` | `src/index.js` banner | the banner printed a fragment of `PINCH_KEY` | banner prints the URL only |
| `js/file-system-race` ×3 | `src/server.js` static files, `src/tools.js` grep, `scripts/setup.js` `.env` backup | `stat`/`existsSync` then use | one `open()` + bounded `read()`; grep reads at most 400 kB through a single descriptor; backup tolerates `ENOENT` |
| `js/file-system-race` | `scripts/setup.js` profile write | read for display, write later | read without a probe; write to a temp file and `rename` |
| `js/clear-text-logging` ×3 | `scripts/pair.js` | the terminal printed the keyed pairing URL, then the port straight out of the env object | the key now exists only inside the QR payload; `--show-key` was removed; the port is parsed to an integer first |
| `js/stack-trace-exposure` | `src/server.js` `json()` | 4xx responses relayed `err.message` | responses are picked from a status-code table; nothing exception-shaped can reach a client by construction |
| `js/tainted-format-string`, `js/log-injection` | `src/server.js` error log | request URL interpolated into a log line | the log carries only a method from a fixed set, the URL's byte length, the status and the error object — no request text reaches the log at all. (Scrubbing the text was not enough: the check wants the flow gone, and it is right that a log line is not the place for attacker-chosen bytes.) |
| `js/file-access-to-http` | `scripts/setup.js` `checkTelegram` | a token read from `.env` goes into a request URL | token must match an anchored shape regex **and** is percent-encoded before it becomes a path |

Three alerts were created by this pass itself and closed the same way —
`js/tainted-format-string` and `js/log-injection` on the new error log, then
`js/log-injection` again on the next version of that line. Each one was a fair
cop: the log was carrying request text. (The column numbers in a CodeQL alert
lag behind the code, so every one of these was located by grepping the rule's
sink rather than by trusting the line number.)

Two of these were found by the new fuzz suite rather than by the scanner or the
unit tests: the calculator tool let a parser exception escape instead of
returning `{ ok: false }`, and `decode()` needed the fixed-point loop described
above. Both are pinned by tests now.

## CodeQL: 2 dismissed, with reasons

Both are the same shape: **the taint flow is the product.** A local-first chat
app exists to take text off a socket and put it in a file, and to take a token
out of a file and put it in a request. The queries are right that data flows
from an untrusted source to a dangerous sink; they are wrong that this
particular flow is the attack.

### `js/http-to-file-access` — `src/store.js` `atomicWrite`

> **Dismissed: won't fix.** Chat text arriving over HTTP is written to the
> user's own session file; that is the feature, and refusing it would mean
> refusing to save conversations. Containment: the destination is built by
> `sessionPath()` (character allowlist, leading dots neutralised, resolved path
> must stay inside `data/sessions`), and `atomicWrite()` re-checks containment
> against `data/` and requires any JSON payload to parse back before it is
> written. Files are never executed or templated; the model may read them back
> as context, which is the documented prompt-injection risk in `AUDIT.md`.

### `js/file-access-to-http` — `scripts/setup.js` `checkTelegram`

> **Dismissed: won't fix.** The installer verifies a bot token by asking the
> provider that issued it — `api.telegram.org` is a literal, not something a
> caller supplies. Confinement: the token must match an anchored shape regex
> (`^\d{6,12}:[A-Za-z0-9_-]{30,}$`) and is percent-encoded into the path, so it
> cannot reshape the request or redirect it. The alternative — not checking the
> token — is worse: the user would find out it was expired when their messages
> silently went nowhere.

## OpenSSF Scorecard: 2 closed by configuration, 4 dismissed

Scorecard scores the *project*, not the code, so most of these can only be
answered by time or by the maintainer's decisions. Each dismissal says which.

| Check | Disposition |
| --- | --- |
| `BranchProtectionID` | **Fixed by configuration.** `main` now requires a pull request, one approving review, the `smoke` / `test (22)` / `test (24)` / `test (26)` checks with the branch up to date, and forbids force-pushes and deletion. |
| `SecurityPolicyID` | **Fixed by configuration.** Two causes, both found by reading the check's source. It matches policy files **by basename and stops at the first hit**, so `.github/ISSUE_TEMPLATE/security.md` — an issue template — was being scored as the security policy, and a template has no reporting link. It is now `security-report.md`. Separately, `docs/SECURITY.md` is also treated as a policy file, so it now links the advisory form too. |
| `CodeReviewID` | **Dismissed: won't fix.** The check counts approved changesets in recent history (`0/13`). The repo has one maintainer, so there is no second party to approve — and a self-approval would be a lie. The review requirement is now enforced, so the ratio rises as contributors arrive and their PRs are reviewed. |
| `MaintainedID` | **Dismissed: won't fix.** It scores "repository was created within the last 90 days" — a statement about a date, not about the project. It clears itself on its own schedule; nothing to fix. |
| `FuzzingID` | **Dismissed: won't fix.** Scorecard credits OSS-Fuzz / ClusterFuzzLite integration specifically. This repo has property-based fuzzing in `test/fuzz.test.js` — seeded, 7 properties, 1 500 iterations per run and soaked at 40 000 — running in the normal test suite, which is cheaper and always on rather than a hosted service that needs a container harness. If the input surface ever grows beyond the user's own machine, adopting ClusterFuzzLite is the right answer and this row changes. |
| `CIIBestPracticesID` | **Dismissed: won't fix.** The badge is an application to OpenSSF Best Practices, filled in by the maintainer at `bestpractices.dev`; it cannot be earned by a commit. Tracked as a maintainer task, not a code task. |

## Re-running the scanners

```sh
# CodeQL and Scorecard both run on every push to main
gh workflow run security.yml --ref main

# What is still open?
gh api repos/{owner}/{repo}/code-scanning/alerts --jq \
  '.[] | select(.state=="open") | "\(.number) \(.rule.id) \(.most_recent_instance.location.path)"'
```

A dismissed alert stays dismissed until the same rule fires again on a new
line. When it does, the comment on the alert is the place to record why the
previous reasoning does or does not still hold.
