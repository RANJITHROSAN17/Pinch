# Contributing to Pinch 🦞

Pinch is a personal project that happens to be useful to other people. Contributions are
welcome, especially the kind that make it **safer** or **work in more places**.

## Ground rules

1. **No new runtime dependencies.** This is a feature, not an accident: the whole gateway is
   Node standard library so it installs instantly and cannot be broken by a transitive release.
   The only exceptions live in `optionalDependencies` (the WhatsApp bridge, the terminal QR).
   If you need something, write the 100 lines — `src/channels/ws.js` is the example.
2. **Anything that mutates the machine needs `dangerous: true`** on its tool definition. If a
   new tool can write, delete, execute or spend, it goes behind the approval gate. No exceptions.
3. **Never widen the sandbox to make a test pass.** `PINCH_WORKSPACE` containment is checked in
   `resolveInWorkspace()`. If your change needs a path outside it, the tool is wrong, not the guard.
4. **If the model can get it wrong, check it in code.** That is what `src/guard.js` is for. A new
   class of claim ("I booked it", "I paid") should come with a matching audit rule.
5. **Be honest in the docs.** If something is half-working, say so in the README's limitations
   section. A documented gap is fine; an undocumented one is a lie.

## Getting set up

```bash
git clone https://github.com/RANJITHROSAN17/Pinch && cd pinch
npm test          # 93 tests, no model needed
npm run audit     # the adversarial self-check — does the product still refuse attacks?
npm run demo      # mock brain — the whole app, no Ollama required
npm run verify    # both of the above, the full gate
```

You do **not** need a GPU, an API key or any chat tokens to develop most of Pinch. The mock
brain exercises the full agent loop, streaming, approvals and reminders.

## Where things live

| Path | What belongs there |
|---|---|
| `src/tools.js` | a new capability. Declare it once; every channel gets it free |
| `src/channels/*.js` | a new chat app. Receive text → `routeMessage()` → send text |
| `src/agent.js` | the loop, approvals. Change reluctantly |
| `src/guard.js` | new honesty rules, with a test each |
| `src/timeparse.js` | natural-time parsing. Pure, clock-injected, testable |
| `test/*.test.js` | must pass on Node 22, 24 **and** 26 (CI runs all three) |
| `scripts/audit.js` | a new probe, if you add a guard rail. Same rules as `test/` |
| `.github/prompts/self-improvement.md` | the rules an agent must follow before proposing work here |

## If you touch a guard rail

`src/tools.js` (sandbox, command screen, child environment), `src/server.js` (host/origin
checks) and the panel's renderer are the parts an attacker aims at. Two extra rules:

1. `npm run audit` must still pass — it runs the probes from `docs/AUDIT.md` against your
   change. If a probe starts failing, the change reintroduced a real defect; the probe is
   not the thing to edit.
2. If you find a *new* way through, add it to `scripts/audit.js` **and** `test/audit.test.js`,
   then fix it. A bypass that is closed but unrecorded will reopen.

## Adding a tool (the common case)

```js
{
  name: "deploy_preview",
  dangerous: true,                       // ← required if it can change anything
  description: "Build and deploy the current project to a preview URL.",
  parameters: {
    type: "object",
    properties: { project: { type: "string", description: "folder name" } },
    required: ["project"],
  },
  async run({ project }, ctx) {
    const res = await runShell("npm run deploy", { cwd: project });
    return { ok: res.ok, output: res.stdout || res.stderr };
  },
}
```

Then add one test that asserts the happy path **and one that asserts refusal** — the refusal
test is the one that matters.

## Style

- Plain ESM, no build step, no TypeScript. JSDoc where it earns its keep.
- Comments explain *why*, not *what*. If a line needs a "what" comment, rename something.
- Errors are values the model can read and act on: `{ ok: false, output: "…" }`, never a throw
  from a tool body unless it is genuinely exceptional.
- Keep the lobster theme to a garnish. Never at the cost of a correct answer.

## Pull requests

- One idea per PR, with the reasoning in the description. If it changes behaviour, say what
  breaks and who might notice.
- `npm test` green, `node --check` on anything you touched.
- Security-relevant changes: explain the threat you are defending against. "It felt safer" is
  not a threat model — `docs/SECURITY.md` sets the tone.

## Reporting a security issue

Please **do not** open a public issue for an approval-gate bypass, sandbox escape, or anything
that lets a message from an unauthorised account reach a tool. Open a minimal private report via
GitHub's "Report a vulnerability" on the Security tab, and include the smallest reproduction you
can.
