<img src="./assets/banner.svg" width="100%" alt="Pinch — a personal AI assistant that lives on your own machine. Private, local, yours." />

# 🦞 Pinch

<p>
  <a href="https://github.com/RANJITHROSAN17/pinch/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/RANJITHROSAN17/pinch/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520.6-3c873a" />
  <img alt="tests 35" src="https://img.shields.io/badge/tests-35%20passing-4dd6c1" />
  <img alt="tools 21" src="https://img.shields.io/badge/tools-21-ff8f6b" />
  <img alt="dependencies 0" src="https://img.shields.io/badge/runtime%20deps-0-ff6a4d" />
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/licence-MIT-ffc061" /></a>
</p>

**A personal AI assistant that lives on your own machine.**
It reads and writes code, runs commands, searches the web, remembers you — and you talk to it
from Telegram, Discord, Slack, WhatsApp, or your phone's browser, with your voice.

Private by default. No account, no cloud, no telemetry. Fast because the model is local.
Yours because the data is a folder you can `rm -rf` whenever you like.

![Pinch demo — boot, a real tool call, streaming reply, an in-chat approval, a reminder firing on your phone, and the honesty check catching a lie](assets/demo.gif)

```
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
      🦞  P I N C H   v1.0
   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

---

## Why this exists

Most "personal assistants" are a chat box wired to somebody else's server. Pinch is the
opposite: one Node process on your laptop, desktop, or the Raspberry Pi in the corner.
Your conversation history is JSON in `data/`. The model runs on your GPU or CPU.
When the internet dies, Pinch keeps working — only web search notices.

What makes it more than a chat toy: **it actually does things**, and it **cannot do anything
you have not allowed**. Every shell command and file write is gated behind an approval
prompt that appears in whichever app you are messaging from.

---

## 60-second quickstart

```bash
cd pinch
npm run setup        # guided: brain → channels → voice → lock it down
npm start            # panel on http://localhost:7777
pinch pair           # QR for your phone
```

Other commands worth knowing:

| Command | Does |
|---|---|
| `pinch doctor` | re-verify every token and connection |
| `pinch brain-test` | model speed + whether it can call tools |
| `pinch pair` | phone URL + locally-generated QR |
| `pinch chat` / `pinch ask "…"` | terminal use, same brain and memory |
| `pinch supervise` | restart-on-crash wrapper, any OS |
| `pinch service --install` | systemd/launchd/Task Scheduler entry |
| `npm run demo` | run everything with a mock brain, no model needed |

That's it. `npm run setup` walks you through it, verifies each token against the real
service before saving, and prints the exact URL to open on your phone.

**No model installed yet?** Try the whole thing with a canned brain first:

```bash
npm run demo         # mock brain, no keys, no model — proves the plumbing
```

### Requirements

| Thing | Notes |
|---|---|
| Node.js ≥ 20.6 | `node --version` |
| A model | [Ollama](https://ollama.com) locally (recommended), or any OpenAI-compatible API |
| Optional | `npm install` only if you want the WhatsApp bridge |

Everything else is standard library. The whole gateway is a few thousand lines you can read
in an afternoon — no framework, no transitive dependency tree, no supply-chain surprises.

---

## What it can do

Pinch decides which tool to reach for, runs it, reads the result, and keeps going — up to
eight rounds per turn — then answers you in plain language.

| Tool | What it is for | Asks permission |
|---|---|:---:|
| `shell` | git, tests, builds, package managers, anything in a terminal | ✅ |
| `read_file` / `write_file` | read code, apply fixes, generate files | write ✅ |
| `list_dir` / `grep` | find where something lives before changing it | — |
| `scan_project` | summarise an unfamiliar repo: tree, stack, README headline | — |
| `search_web` | current facts, docs, error messages | — |
| `calculator` | exact arithmetic, no floating-point guessing | — |
| `remind` / `list_reminders` / `cancel_reminder` | "remind me in 20 minutes", delivered back to the chat that asked | — |
| `open_url` | open a page in your browser ("open YouTube") | — |
| `screenshot` | capture the screen to a file | ✅ |
| `system_control` | lock or sleep the machine (no shutdown, by design) | ✅ |
| `remember` / `recall` / `forget` | durable facts about you, across restarts | — |
| `add_task` / `list_tasks` / `complete_task` | lightweight task list | — |
| `time_now` | timezone-correct dates | — |

Typical things people actually use it for:

- *"scan ~/code and tell me which repo is uncommitted"*
- *"this test fails with a weird error — read it and fix it"*
- *"remind me in 40 minutes to check the deploy"* — it messages you back, in the same app
- *"remember that I deploy on Fridays only"* → it still knows next week
- *"what is on my screen right now?"* → screenshot, then it reads it
- *"explain this stack trace"* — dictated into the phone mic
- *"hey pinch, open my repo"* — hands-free, while the panel is open

---

## New in this upgrade

Built after auditing a well-made local assistant setup guide (Keena) and taking the ideas that
actually make a difference here — while deliberately skipping the ones that depend on Windows,
a discrete GPU, or power tools people do not have.

| Upgrade | Why it matters |
|---|---|
| **Reminders that fire** | `remind` parses "in 20 minutes", "at 6pm", "tomorrow at 9am" and delivers **back to the chat that asked** — Telegram stays on Telegram. Late deliveries say they were late instead of pretending. |
| **Real streaming** | Tokens appear as the model writes them, in the panel and in the terminal. First-token latency is what "feels fast"; total latency rarely is. |
| **Honesty guard** | A code-level audit of every reply: did it claim an action no tool performed? invent an email nobody gave it? cite a URL nothing fetched? invoke "your memory" with an empty memory? Mismatches are shown to you, not silently rewritten. |
| **`Hey Pinch` wake word** | Opt-in, panel-only, off by default. The browser's own recogniser matches locally; audio never leaves the device until a command actually follows. |
| **Tamil / Hindi dictation** | The mic language is a dropdown (EN·IN, EN·US, தமிழ், हिन्दी). The guide was right that this is the single biggest usability win for a lot of people. |
| **PC actions** | `screenshot` (macOS/Linux/Windows), `open_url`, `system_control` (lock/sleep — shutdown deliberately absent). All destructive ones behind the approval gate. |
| **A profile file** | Write plain facts about yourself once in `data/profile.md`; Pinch reads them every turn and is forbidden from inventing beyond them. |
| **`pinch pair`** | Prints the phone URL and a locally-generated QR — never through a third-party QR service, which would be a funny way to leak the key that guards your machine. |
| **`pinch brain-test`** | Measures first-token speed and — the question that actually matters — whether your model can call tools at all. A model that chats well but never calls a tool makes Pinch an expensive diary. |
| **`pinch service` / `pinch supervise`** | Always-on: systemd unit (installed only when you ask), launchd plist, Windows Task Scheduler line, plus an any-OS restart-on-crash wrapper. |

### What the guide got right that Pinch now copies outright

- **Say plainly what leaves the machine.** See the table below.
- **A model can be wrong about itself.** Check its claims in code, not in the prompt.
- **Never invent a time.** If the phrase is not understood, ask — do not guess 9am.
- **Give people the exact URL and a QR**, and let them tap once before the mic works.
- **Say what the hardware needs, honestly.** Local models are the point, so be blunt about VRAM.

## Talking to it from anywhere

Set up as many or as few as you want. All channels share one brain, one memory, one workspace.

| Channel | Effort | How it works | Voice in |
|---|---|---|---|
| 🌐 **Web panel** | none | `http://localhost:7777`, works on any device on your Wi-Fi | **🎙️ built in** |
| ✈️ **Telegram** | ~2 min | Bot API long polling; approvals arrive as inline buttons | dictation |
| 🎮 **Discord** | ~5 min | Gateway over Pinch's own WebSocket client | dictation |
| 💼 **Slack** | ~5 min | Polls `conversations.history` with a bot token | dictation |
| 💬 **WhatsApp** | ~3 min | Unofficial WhatsApp Web bridge (Baileys) — read the warning below | dictation |

### Telegram (do this one first)

1. Message **@BotFather** → `/newbot` → copy the token.
2. Message **@userinfobot** → copy your numeric id.
3. `npm run setup` → paste both. The bot only answers people on your allowlist; anyone else
   gets told their own id so you can decide.

Approvals show up as **✅ Allow / ❌ Deny** buttons.

### Discord

1. [discord.com/developers](https://discord.com/developers/applications) → New Application → **Bot** → Reset Token.
2. **Bot → Privileged Gateway Intents → Message Content Intent → ON.** Pinch looks deaf without this.
3. OAuth2 → URL Generator → scope `bot` → invite it to your server.
4. Settings → Advanced → Developer Mode, then right-click the channel → Copy Channel ID.

### Slack

Create an app at [api.slack.com/apps](https://api.slack.com/apps) → **OAuth & Permissions** → bot scopes:
`chat:write`, `channels:history`, `channels:read`, `users:read`. Install it, invite `@yourbot`
to a channel, and put that channel id (`C0123…`) in `.env`.

### WhatsApp — read this one carefully

Pinch supports it, off by default, because the trade-off is real:

- It uses the **unofficial** WhatsApp Web protocol (Baileys). Automating a personal account
  **violates WhatsApp's Terms of Service**, and accounts have been banned for it.
- **Use a secondary number you can afford to lose.** Never your primary.
- Messages still pass through WhatsApp's servers — that is how WhatsApp works. This channel
  is private from third parties, not from WhatsApp.
- To enable: `WHATSAPP_ENABLED=true` in `.env`, `npm install`, then `npm start` and scan the
  QR with WhatsApp → Linked devices.

If any of that bothers you, skip WhatsApp. Telegram does everything it does, officially, in
two minutes.

---

## Voice, on your phone

The most natural way to use Pinch is your phone, talking to it.

1. Open `http://<your-computer-ip>:7777?key=…` in **Safari** (iPhone) or **Chrome** (Android).
2. Share → **Add to Home Screen**. It now opens full-screen like an app.
3. Tap **🎙️**, speak, and it sends automatically when you stop.
4. Tap **🔈** to have replies spoken back.

Transcription uses the phone's own speech engine — free, fast, and it does not send audio to
a server of ours (there is no server of ours). Dictation also works in every messenger app,
so on Telegram you can use the keyboard mic there.

Want *voice notes* sent into chat apps transcribed? Point `WHISPER_URL` at a local
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) server. Not built in by default,
because a half-working transcription is worse than an honest "no".

---

## How it works

```
 Telegram ─┐
 Discord  ─┤                    ┌──────────────┐      ┌──────────────┐
 Slack    ─┼──► channels/ ─────►│              │─────►│   Ollama     │
 WhatsApp ─┤    (routers)       │   agent.js   │      │  (local LLM) │
 Web/SSE  ─┘                    │  tool loop   │◄─────│  or OpenAI-  │
                                │  + approvals │      │  compatible  │
                                └──────┬───────┘      └──────────────┘
                                       │
                        ┌──────────────┼───────────────┐
                        ▼              ▼               ▼
                   tools.js        store.js        prompt.js
                (14 tools,       (memory,          (lobster
                 sandboxed)       sessions,        personality)
                                  tasks)
```

The design choice that makes it reliable: **the brain is a swappable interface**, and
**every channel speaks the same `routeMessage()` contract**. Adding a channel never touches
agent logic; adding a tool never touches a channel.

```
src/
  index.js           boot: banner, brain probe, server, channels
  agent.js           the tool loop + permission gate (the heart)
  brain.js           Ollama / OpenAI-compatible / mock, one interface
  prompt.js          personality, honesty rules, context
  tools.js           14 tools, path sandbox, command screen, safe maths
  store.js           atomic JSON persistence: memory, sessions, tasks
  server.js          HTTP + SSE + auth; serves the web panel
  cli.js             terminal chat
  channels/
    router.js        one brain, many doors (commands, yes/no, chunking)
    telegram.js      long polling + inline approve buttons
    discord.js       gateway client
    ws.js            ~120-line RFC 6455 WebSocket client (no deps)
    slack.js         conversations.history polling
    whatsapp.js      optional Baileys bridge
public/index.html    the whole panel: UI, streaming, voice, memory drawer
scripts/setup.js     the guided wizard and the doctor
```

---

## What stays on your machine, and what uses the internet

Being honest about this matters, so here it is plainly.

| Runs on your machine (private) | Uses the internet |
|---|---|
| The model and all reasoning (`LLM_PROVIDER=ollama`) | Your voice replies, if you enable 🔈 — the browser's speech synthesis may use an OS/cloud voice |
| Web panel, chat bridges, reminders, scheduler | `search_web` (DuckDuckGo) — the only tool that needs a network to work |
| Conversation history, memory, profile, tasks (`data/`) | Telegram / Discord / Slack / WhatsApp — obviously; that is how they work |
| Dictation (browser speech engine, on-device on iOS/Android) | `pip/npm/git` commands you ask it to run |
| File access, shell, screenshots, approvals | Anything you set `LLM_PROVIDER=openai` to point at |

If you use Telegram, your messages pass through Telegram's servers — Pinch's *processing* is
local, the *transport* is not. That is the same honest trade the guide makes, and the web panel
exists for when it matters.

## Security model — what it protects and what it doesn't

Pinch runs shell commands. That is the point, and that is the risk. The design assumes
**the model can be wrong or manipulated**, so the guardrails do not rely on it behaving.

**Layers that are enforced in code, not in the prompt:**

1. **Approve every mutating action.** `shell` and `write_file` block until a human answers
   in-chat. Default is deny; unanswered prompts expire after 10 minutes.
2. **Workspace sandbox.** Reads and writes are resolved and checked against `PINCH_WORKSPACE`.
   `../../etc/passwd` and `~/.ssh/id_rsa` are refused with an explanation, not a crash.
3. **Catastrophic-command screen.** `rm -rf /`, `mkfs`, `dd of=/dev/sda`, fork bombs are
   refused before the approval prompt even appears.
4. **Allowlists per channel.** A Telegram user id, a Discord channel, a WhatsApp number. A
   stranger who finds your bot gets their own id back, not a shell.
5. **Access key on the panel.** `PINCH_KEY` is required for every `/api` call and web page.
   Without it, any device on your Wi-Fi can drive your assistant — the wizard generates one.
6. **Bounded blast radius.** 8 tool rounds per turn, 120 s per command, output truncated,
   `data/` capped, no `eval()` anywhere (the calculator is a real parser).

**What this does *not* protect you from:**

- **A malicious model.** If you ask a 7B model to "clean up my repo" and approve
  `rm -rf ~/projects`, that is on the approval screen. Read the prompt before you tap Allow.
- **Prompt injection** from web pages or file contents the model reads. Web search results
  can contain instructions. The approval gate is your real defence; treat "Allow" as a
  decision, not a formality.
- **Someone with access to the machine.** Encrypt your disk. `data/` is plain JSON.
- **Cloud providers.** If you switch `LLM_PROVIDER=openai`, your prompts go to whoever runs
  that endpoint. That is a deliberate, visible choice — the default is local.

**Hardening checklist for a shared or untrusted network:** set `PINCH_KEY`, keep
`PINCH_AUTO_APPROVE=false`, keep `PINCH_WORKSPACE` narrow (one projects folder, not `~`),
and bind to `127.0.0.1` if you only use it from that machine.

---

## What hardware this needs

Pinch is CPU-friendly in a way GPU-first assistants are not: a 7B model at Q4 runs on an
ordinary laptop, and the panel + channels cost almost nothing. But the honest numbers matter —
borrowed straight from the kind of setup guide that tells you the truth.

| Part | Minimum | Comfortable |
|---|---|---|
| OS | macOS, Linux, Windows — any | any |
| Model | `qwen2.5-coder:3b` on CPU (slow but usable) | `qwen2.5-coder:7b` (≈5 GB) |
| GPU | not required | NVIDIA 8 GB+, Apple Silicon 16 GB unified, AMD 8 GB+ |
| RAM | 8 GB | 16 GB (32 GB for 14B+) |
| Storage | 5 GB for a 7B model | 20 GB |
| Internet | needed for chat apps and web search | broadband |
| Browser | any modern one; Chrome/Edge for the mic | Safari on iOS, Chrome on Android |

**Check before you trust it:**

```bash
pinch brain-test     # speed + tool-calling support
ollama ps            # should say 100% GPU if you have one
```

If `ollama ps` says CPU while you own a GPU, the model does not fit in VRAM. Drop to a smaller
quant (`qwen2.5-coder:7b-instruct-q4_K_M`) or a smaller model. On Apple Silicon there is no
`ollama ps` GPU line to worry about — Metal handles it transparently.

**Models that call tools reliably:** `qwen2.5-coder:7b`, `qwen3:8b`, `llama3.1:8b`,
`mistral-nemo:12b`. Avoid base/chat-only models for agent work — `pinch brain-test` will tell
you in ten seconds.

## Updating and uninstalling

```bash
# update
cd pinch && git pull && npm install     # optional deps only
# your .env and data/ are untouched by a pull

# uninstall
rm -rf pinch                            # this deletes conversations, memory, reminders
ollama rm qwen2.5-coder:7b              # optionally drop the model
```

Nothing is written outside the folder except the systemd/launchd/Task Scheduler entry, if you
ran `pinch service --install`. Remove that with the command it prints.

## Configuration

Everything lives in `.env` (generated by `npm run setup`, commented template in
`.env.example`). The ones that matter:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` · `openai` · `mock` |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | any model you have pulled; coder models are best for dev work |
| `PINCH_WORKSPACE` | `~` | comma-separated roots the agent may touch |
| `PINCH_KEY` | *(generated)* | shared secret for the web panel |
| `PINCH_AUTO_APPROVE` | `false` | `true` = no approval prompts. You have been warned. |
| `PINCH_PORT` | `7777` | panel port |
| `TELEGRAM_TOKEN` / `TELEGRAM_ALLOWED_IDS` | — | bot + your numeric id |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_IDS` | — | bot + channels to watch |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_IDS` | — | `xoxb-…` + channels |
| `WHATSAPP_ENABLED` / `WHATSAPP_ALLOWED_NUMBERS` | `false` | unofficial bridge, opt-in |
| `WHISPER_URL` | — | optional local whisper.cpp for voice notes |

**Model picking:** `qwen2.5-coder:7b` is the sweet spot for laptops with 8–16 GB. On 32 GB,
`qwen2.5-coder:32b` is a genuine step up. On a small VPS or Pi, `llama3.2:3b` works if you
keep tasks tight. Tool calling needs a model that supports it — Qwen 2.5, Llama 3.1+, and
Mistral all do.

---

## Extending it

**A new tool** is ~15 lines in `tools.js`:

```js
{
  name: "deploy_preview",
  dangerous: true,                    // gate it behind approval
  description: "Build and deploy the current project to a preview URL.",
  parameters: { type: "object", properties: { project: stringProp("folder name") }, required: ["project"] },
  async run({ project }) {
    const res = await runShell(`npm run deploy`, { cwd: project });
    return { ok: res.ok, output: res.stdout || res.stderr };
  },
}
```

It is instantly available on every channel, and it will ask before running because
`dangerous: true`.

**A new channel** (Signal, Matrix, email, SMS) is a function that receives text and returns
text — copy `telegram.js`, call `routeMessage({ channel, text, send })`, done. `ws.js` is
there if your service speaks WebSocket.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `brain: ollama unreachable` | Ollama is not running | `ollama serve` in another terminal |
| model replies but never uses tools | model lacks tool calling | `ollama pull qwen2.5-coder:7b` |
| Discord bot ignores everything | Message Content Intent off | Developer portal → Bot → enable it |
| Telegram bot silent, user gets their id | not on the allowlist | add the id to `TELEGRAM_ALLOWED_IDS` |
| Phone cannot open the panel | wrong IP or firewall | same Wi-Fi; allow port 7777 on the host firewall |
| `401 bad or missing PINCH_KEY` | key missing in URL/cookie | open the URL with `?key=…` once |
| Everything hangs on a prompt | an approval is waiting | answer **yes**/**no**, or check `/api/approvals` |
| Model is slow | model too big for the hardware | smaller quant, or `LLM_PROVIDER=openai` for heavy tasks |
| `ollama ps` shows CPU, not GPU | model does not fit in VRAM | smaller quant/model; close games; update drivers |
| Model chats but never runs tools | model lacks tool calling | `pinch brain-test`, then switch to qwen2.5-coder / qwen3 / llama3.1 |
| Reminders never arrive | channel that created it is offline | it falls back to the web panel and logs the reason |
| "It said it sent an email and didn't" | model over-claimed | that is exactly what the honesty guard flags — read the check line |
| 🛡️ Code check keeps appearing | model is over-claiming regularly | use a more capable model; the guard is doing its job |
| "Hey Pinch" does nothing | browser has no speech engine, or mic denied | Chrome/Edge/Safari, allow the mic, keep the tab open |
| Panel mic transcribes the wrong language | dictation language | use the EN·IN / தமிழ் dropdown in the header |

`npm run doctor` re-checks all of the above against the live services.

---

## Honest limitations

- **Voice notes in chat apps are not transcribed** unless you point `WHISPER_URL` at a local
  whisper.cpp server. Phone dictation works everywhere and is the better path.
- **WhatsApp is unofficial and can get a number banned.** Deliberately off by default.
- **Web search breaks without internet.** Everything else keeps working.
- **No multi-user support.** One owner, by design; the allowlist is a lock, not a permissions system.
- **7B-class models are not a frontier model.** They are good at focused engineering work and
  bad at sprawling open-ended reasoning. Pinch tells you when it is unsure instead of
  inventing a file's contents — the prompt forbids bluffing.
- **No wake-word, no always-listening mic.** Deliberate: always-on audio is a privacy problem
  dressed as a feature. The panel mic is push-to-talk.

**Roadmap, in the order it would actually help:** voice-note transcription, streaming token
output, a `git`-aware review tool, scheduled jobs ("every morning, summarise my PRs"), and a
second-model critic for risky diffs.

---

## FAQ

**Is it really free?** Yes. The code is MIT, Ollama and the models are free, and there is no
service to subscribe to. You pay for your own electricity.

**Does it need ChatGPT or an API key?** No. The default brain runs on your machine. Keys are
only needed if you deliberately point it at a cloud endpoint.

**Can I change its name or voice?** The name is in `src/prompt.js` (and the wake-word regex in
`public/index.html`). The voice comes from your OS in the panel; on the phone it is the system
voice, so change it in iOS/Android accessibility settings.

**Can it speak other languages?** Comprehension, yes — Tamil and Hindi dictation are built in.
Spoken replies follow the browser/OS voice, so it will speak whatever that voice supports. The
guide correctly refused to have a small local model *generate* Tamil prose; Pinch does the same
thing by not claiming what it cannot verify.

**Will it run on my laptop?** See the hardware table. A 7B Q4 model on 16 GB RAM is the realistic
sweet spot.

**Why not a wake word all the time, even with the app closed?** Because always-on microphones are
a privacy problem wearing a feature's clothes. Pinch's wake word exists only while a tab is open,
and you opt in each session.

**Is WhatsApp safe to enable?** Read `docs/CHANNELS.md`. Short version: it is unofficial, against
WhatsApp's ToS, and can get a number banned. Telegram does the same job legitimately.

**Does it remember things I did not ask it to?** No. `remember` is only called when you ask it to
remember, or when you write it in `data/profile.md`. Everything is a plain JSON file you can read.

## Licence

MIT. Your machine, your data, your lobster.

<sub>Named for the pinch: a small claw that holds on and does not let go — and a nod to the
lobster mascot this project grew out of.</sub>
