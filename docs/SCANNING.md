# What the scanners found, and what happened to each finding

This is the audit trail for the code-scanning alerts on `main` — every alert,
how it was closed, and the four that were dismissed with a reason rather than
fixed. If you are reading this because an alert reappeared: start at
[Re-running the scanners](#re-running-the-scanners).

At the start there were **24 open alerts**: 18 from CodeQL and 6 from OpenSSF
Scorecard. All 18 CodeQL findings were real enough to act on — none were
dismissed as false positives silently. The Scorecard findings were about repo
configuration and project age, not code.

## CodeQL: 14 closed in code

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
