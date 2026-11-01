# Support policy

Which runtimes Pinch supports, until when, and what happens when one runs out.

The short version: **we support the minimum Node version until it reaches end of life
upstream.** Then the minimum moves up, in one deliberate step, before the security patches
stop — not after.

## Node.js

| Version | Status upstream | Supported here | Tested in CI |
|---|---|:---:|:---:|
| **26** | Active LTS since 2026-10-28 · EOL 2029-04-30 | ✅ recommended | ✅ |
| **24** | Active LTS since 2025-10-28 · EOL 2028-04-30 | ✅ | ✅ |
| **22** | Maintenance (security only) since 2025-10-21 · **EOL 2027-04-30** | ✅ works, dropped at EOL | ✅ |
| 20 | **End of life 2026-04-30** — no security patches at all | ❌ | ❌ |

`package.json` declares `engines.node: ">=22"`. Nothing in Pinch needs a newer runtime than
that; the floor moves for security reasons, not for language features.

### The next scheduled change

**Node 22 is dropped when it reaches end of life on 2027-04-30.** At that point:

1. `engines.node` becomes `>=24`,
2. `22` leaves the CI matrix,
3. this table loses a row.

This is not a note in a todo list — the weekly [tech radar](../scripts/tech-radar.js) refetches
the real dates from [endoflife.date](https://endoflife.date/nodejs) and escalates the finding
to **high** the moment the minimum supported version is past its EOL. If this file and the
calendar ever disagree, the calendar wins and the workflow says so.

### What it looks like if you run something unsupported

- **Node 20:** `npm install` warns about `engines`. You can force it, and Pinch may well run
  — but no test covers that combination, and no security patch will reach you.
- **Node 22 (maintenance tier):** works, is tested, and prints **one line at startup** —
  once per install, not on every boot — saying it is in maintenance and when that ends:

  ```
  ▲ Node 22 is in maintenance — security fixes only, until 2027-04-30.
    That is still supported; plan the move to Node 26 before then. See docs/SUPPORT.md.
  ```

  Version 24 and 26 say nothing at all. Nagging someone for running a supported LTS is
  not support.

## Operating systems

| OS | Status |
|---|---|
| Linux | Supported, CI runs on Ubuntu |
| macOS | Supported, including Apple Silicon |
| Windows 10/11 | Supported — `shell` uses `cmd.exe`, services use Task Scheduler |

Everything is Node standard library, so if Node runs there, Pinch runs there. Linux
screenshots additionally need `gnome-screenshot`, `scrot`, `imagemagick` or `grim`;
macOS and Windows use the built-in capture.

## Models

Not a support matrix so much as a requirement: the model must be able to **call tools**.
A chat-only model turns Pinch into an expensive diary. Check yours in ten seconds:

```bash
npm run brain        # first-token speed, and whether tool calling actually works
```

Anything Ollama serves, plus any OpenAI-compatible endpoint (OpenAI, Groq, LM Studio, vLLM,
OpenRouter). Local is the default; cloud is a choice you make in `.env`.

## How this policy is enforced

| Where | What it does |
|---|---|
| `package.json` → `engines` | warns at install time |
| GitHub Actions matrix | only supported versions are actually tested |
| `npm run radar` (weekly) | refetches real lifecycle dates; escalates when a supported version passes EOL |
| `docs/SUPPORT.md` | this file — the decision, written down where a human can argue with it |

If a supported combination breaks, that is a bug worth
[filing](https://github.com/pinchfoundry/Pinch/issues). If an *unsupported* one breaks,
the honest fix is to upgrade your Node.
