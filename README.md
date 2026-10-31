<p align="center">
  <img src="./assets/banner.svg" width="100%" alt="Pinch — a personal AI assistant that lives on your own machine" />
</p>

<h1 align="center">🦞 Pinch</h1>

<p align="center">
  <b>A personal AI assistant that runs on your own computer.</b><br/>
  It reads your code, runs commands, remembers you, sends you reminders, and runs the tasks you schedule.<br/>
  You talk to it from Telegram, Discord, Slack, WhatsApp — or your phone's browser, by voice.
</p>

<p align="center">
  <a href="https://github.com/RANJITHROSAN17/Pinch/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/RANJITHROSAN17/Pinch/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-110%20passing-4dd6c1" />
  <img alt="tools" src="https://img.shields.io/badge/tools-21-ff8f6b" />
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-ff6a4d" />
  <a href="docs/AUDIT.md"><img alt="audited" src="https://img.shields.io/badge/security-audited-ffc061" /></a>
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/badge/licence-MIT-8a5cf6" /></a>
</p>

## Install it in two commands

```bash
git clone https://github.com/RANJITHROSAN17/Pinch && cd Pinch
npm run setup     # one guided command: model → channels → voice → key
npm start         # 🦞  http://localhost:7777
```

`npm run setup` checks your model, writes `.env`, generates a key, and prints the URL to
open on your phone. **No account. No cloud. Nothing to configure by hand.**

Something not working? Two read-only checks, safe to run any time:

```bash
npm run doctor    # reads .env and calls each service: model, Telegram/Discord/Slack tokens, access key
npm run brain     # asks your model for a short reply and a tool call: speed, and whether it can use tools
```

| You need | Notes |
|---|---|
| Node.js 22 or newer | `node --version` |
| A model | [Ollama](https://ollama.com) locally (recommended), or any OpenAI-compatible API |
| Nothing else | Zero runtime dependencies — the rest is the Node standard library |
| Any OS | Linux, macOS, Windows. Free, MIT licensed, no account and no subscription |

**No model installed?** See the whole thing work right now, with a canned brain:

```bash
npm run demo
```

![Pinch demo — boot, a tool call, a streamed reply, an in-chat approval, a reminder arriving, and the honesty guard's output](assets/demo.gif)

---

## What it actually is

- **An assistant that lives where your files are.** Not a chat window with a browser
  plugin: it can read and write files, run commands, and search, up to 8 tool calls per turn.
- **Send it a file.** Drop a PDF, a screenshot or a spreadsheet on the panel and ask
  about it — extracted in-process, never uploaded anywhere. No OCR for scans, and it
  says so instead of pretending.
- **On your machine, with your model.** Default is Ollama on the same laptop. Your
  conversations are JSON files in `data/` — `rm -rf data` is a valid uninstall.
- **Answers you can check.** When it reads a file or searches the web, the reply cites what it
  actually used, and a citation that points at nothing is flagged rather than shown as a link.
- **With a gate on anything destructive.** Shell commands, file writes, screenshots and
  system actions stop and ask you first. Deny it and it genuinely does not run.

You message it like a person, and it works like a very fast intern who has your laptop.

## Ask it things like

> *"scan ~/code and tell me which repos have uncommitted changes"*
> *"this test is failing with a weird error — read it and fix it"*
> *"remind me in 40 minutes to check the deploy"* — it messages you back, in the same app
> *"remember I only deploy on Fridays"* — it still knows next week
> *"what's on my screen right now?"* — screenshot, then it reads it
> *"explain this stack trace"* — dictated into your phone's mic

## What's inside

22 tools. The five that change something ask permission first.

|  | Tools |
|---|---|
| **Your machine** | `shell` ✅ · `read_file` · `write_file` ✅ · `list_dir` · `grep` · `scan_project` |
| **Time & reminders** | `remind` · `list_reminders` · `cancel_reminder` · `time_now` · `schedule` ✅ — a task Pinch runs on a cadence without you |
| **Memory** | `remember` · `recall` · `forget` — facts about you, across restarts |
| **Tasks** | `add_task` · `list_tasks` · `complete_task` |
| **The world** | `search_web` · `calculator` · `open_url` |
| **Third-party tools** | MCP servers over stdio, namespaced, approval-gated unless you name the server trusted |
| **Your desktop** | `screenshot` ✅ · `system_control` ✅ — lock/sleep, never shutdown |

✅ = asks you first.

## Why not just use ChatGPT?

|  | Hosted assistant | **Pinch** |
|---|---|---|
| Your messages | Their servers, indefinitely | Your disk, in `data/` |
| Which model | Theirs, silently swapped | Yours — local by default |
| What it can touch | Whatever their plugins allow | Your actual machine, behind an approval gate |
| Account required | Always | Never |
| Can you read the code | No | Under 6,000 lines, zero dependencies |

## Private by default

The honest version, not a paragraph of reassurance:

| Action | What leaves your machine |
|---|---|
| Chatting with the default local model | **Nothing** |
| `search_web` | the search query → DuckDuckGo |
| Telegram / Discord / Slack | the message text → that platform |
| Cloud model (only if you choose one in `.env`) | your prompts → that provider |
| Memory, sessions, reminders, schedules, files, screenshots | **Nothing** |

```bash
grep -r "fetch(" src/    # every outbound call in the product
```

## It has been attacked on purpose

An assistant with a shell deserves more than "we take security seriously". The build was
attacked from the outside, six real defects were found, all six were fixed, and each one
has a regression test that fails on the old code.

```
npm run audit     # 14 probes, ~2 seconds, no model, no network — try it on your own install
```

| Guard rail | What it means |
|---|---|
| **Approval gate** | Anything destructive stops and shows you the exact argument — values included, shell metacharacters called out. Default deny. |
| **Workspace sandbox** | Files are confined to `PINCH_WORKSPACE`, resolved through `realpath()` — a symlink cannot walk out. `~/.ssh`, `~/.aws`, `~/.gnupg` and friends are refused even when the workspace is your home directory. |
| **No shell for data** | Tools that take a filename run it as argv, never as a command string. `grep` runs model-supplied patterns on a worker thread it can kill. |
| **Command screen** | `rm -rf /`, `rm -rf $HOME`, `find / -delete`, `curl \| sh`, fork bombs, power-off — refused with a reason. |
| **Scrubbed environment** | Commands never inherit your `PINCH_KEY`, `TELEGRAM_TOKEN` or `OPENAI_API_KEY`. |
| **Host + Origin checks** | A website you visit cannot drive your assistant, and DNS rebinding fails. The API key travels in a header, never a cookie, so a stray local dev server cannot read your history. |
| **Honesty guard** | Every reply is audited in code: "I sent it" with no tool that sends gets flagged, visibly. |

Full method, results and **what is still not fixed**: [`docs/AUDIT.md`](docs/AUDIT.md).

## Where you can talk to it

| Channel | Setup | Voice |
|---|---|---|
| 🌐 **Web panel** | none — `http://localhost:7777`, installable on your phone | 🎙️ dictation, spoken replies, optional "Hey Pinch" |
| ✈️ **Telegram** | ~2 min, approvals arrive as buttons | voice notes (with local Whisper) |
| 🎮 **Discord** | ~5 min | dictation |
| 💼 **Slack** | ~5 min | dictation |
| 💬 **WhatsApp** | unofficial, **off by default** — [read this first](docs/CHANNELS.md) | dictation |

## Documentation

| | |
|---|---|
| **[Guide](docs/GUIDE.md)** | architecture, voice, reminders, honesty guard, configuration, extending, FAQ |
| **[Security audit](docs/AUDIT.md)** | how it was attacked, what was found, what was fixed, what remains |
| **[Security model](docs/SECURITY.md)** | threat model and the hardening checklist |
| **[Channels](docs/CHANNELS.md)** | Telegram, Discord, Slack, WhatsApp in detail |
| **[Support policy](docs/SUPPORT.md)** | which Node versions we support, and until when |
| **[Contributing](CONTRIBUTING.md)** | how to add a tool, and the rules around the guard rails |
| **[Growth loop](docs/GROWTH.md)** | how the daily bot decides what to propose — and why it never writes code |

## Honest limits

- **It can do anything you can do in a terminal**, if you approve it. Narrow `PINCH_WORKSPACE`, read the command in the prompt.
- **No GPU?** A 7B model on CPU is 2–4 tokens/sec — usable, not pleasant.
- **WhatsApp is unofficial** and can get a number banned. Telegram does the same job, officially.
- **The command screen is a denylist.** Obfuscated commands still reach you for approval; that is the design.
- **[More limits in the guide](docs/GUIDE.md#honest-limitations)**, including screenshots, voice notes and wake-word caveats.

---

<p align="center">
  <sub>MIT licensed · built to run on a laptop, in a room, for one person · 🦞</sub>
</p>
