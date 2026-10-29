# Channel setup, in detail

Each channel is independent. Enable one, or all five. Pinch boots with whatever is configured.

## Telegram — recommended first channel (~2 minutes)

1. In Telegram, message **@BotFather**.
2. Send `/newbot`, pick a display name and a username ending in `bot`.
3. Copy the token (`123456789:AAE...`).
4. Message **@userinfobot** and copy your numeric id (`Id: 123456789`).
5. `npm run setup` → Telegram step → paste both.

**Why the allowlist matters.** A bot username is public. Without `TELEGRAM_ALLOWED_IDS`,
anyone who finds your bot could drive your laptop. Pinch's default is to refuse everyone
and echo their id back so you can add it deliberately.

**Approvals** arrive as inline ✅ / ❌ buttons. Tapping calls
`/api/approve` under the hood via the callback handler.

**Privacy note.** Telegram is a cloud service; messages pass through Telegram's servers.
Pinch's *processing* is local, but the transport is not. If that matters, use the web panel
or WhatsApp/Signal-style transports you trust.

## Discord (~5 minutes)

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it.
3. **Bot → Privileged Gateway Intents → Message Content Intent → ON.**
   Without this, Discord sends empty message bodies and the bot looks broken.
4. **OAuth2 → URL Generator**: scopes `bot`; permissions at minimum *Send Messages*,
   *Read Message History*. Open the generated URL to invite it.
5. Enable **Developer Mode** (Settings → Advanced), right-click your channel → **Copy Channel ID**.
6. `DISCORD_BOT_TOKEN=…` and `DISCORD_CHANNEL_IDS=…` in `.env`.

Pinch uses its **own WebSocket client** (`src/channels/ws.js`) — no `discord.js`, no
dependency tree, about 120 lines implementing exactly the RFC 6455 client features the
gateway needs, including resume.

## Slack (~5 minutes, needs workspace admin)

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch.
2. **OAuth & Permissions → Bot Token Scopes:** `chat:write`, `channels:history`,
   `channels:read`, `users:read`.
3. **Install to Workspace** → copy the `xoxb-…` token.
4. In Slack, `/invite @yourbot` into the channel, then copy the channel id
   (`C0123456789`, visible in the channel URL or via right-click → Copy link).
5. `SLACK_BOT_TOKEN=…`, `SLACK_CHANNEL_IDS=…`.

Pinch polls `conversations.history` every ~3.5 s rather than using Socket Mode — no public
URL, no second token, and it replies in-thread when the conversation is threaded.

## WhatsApp (optional, unofficial)

```
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_NUMBERS=919876543210,447700900123
```

Then `npm install` (pulls `@whiskeysockets/baileys`) and restart. A QR code prints in the
terminal the first time; scan it with **WhatsApp → Settings → Linked devices**.

**The honest warnings:**

- WhatsApp's Terms of Service prohibit automating a personal account. Enforcement is
  automated and unappealable; numbers get banned.
- Use a **secondary SIM**. Do not risk the number your life runs on.
- Messages transit WhatsApp's servers. Pinch's processing is local; the transport is not.
- The bridge is the most fragile part of Pinch because it chases a moving target.

If those trade-offs are unacceptable — and for most people they should be — use Telegram,
which offers the same "message my assistant from my phone" experience officially.

## Web panel / PWA

Open `http://<host>:7777?key=YOUR_KEY` once per device. The key is stored in a cookie.

- **iPhone:** Safari → Share → Add to Home Screen. Mic works in iOS 14.5+.
- **Android:** Chrome → ⋮ → Add to Home screen. Mic works in Chrome.
- Full-screen, push-to-talk, spoken replies with 🔈.

Tip: put the panel behind [Tailscale](https://tailscale.com) if you want it reachable
outside your home network without exposing a port to the internet. Do **not** port-forward
Pinch directly to the public internet.

### Pairing: `pinch pair`

Prints the LAN URL with the key attached, plus a QR code generated **locally** by
`qrcode-terminal` (`npm i qrcode-terminal`). The QR is never sent to a third-party QR service —
that would be an amusing way to hand your access key to someone else.

### Wake word

The 👂 toggle in the panel header enables "Hey Pinch". It uses the browser's own recogniser in
continuous mode and matches the phrase **on your device**; nothing leaves the machine until a
command actually follows the wake word. It stops when the tab or app closes, and the toggle is
off by default on every device — always-on microphones should be a choice, not a default.

On iOS, Safari may pause recognition when the screen locks; keep the screen on for hands-free
use, or use the mic button on the lock screen's dictation instead.
