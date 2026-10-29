---
name: Security report
about: Do NOT open a public issue for security problems — this just points you to the private path
labels: security
---

**Please do not describe the vulnerability in a public issue.**

If you have found something that bypasses the approval gate, escapes the workspace sandbox, or
lets an unauthorised account reach a tool, report it privately:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Include the smallest reproduction you can, and what an attacker gains.
3. If GitHub private reporting is unavailable, open an issue containing only the words
   "security contact requested" and nothing else — a maintainer will reach out privately.

Useful context to include privately: `docs/SECURITY.md` lists the threat model, so you can say
which layer you defeated (approval gate, path sandbox, command screen, channel allowlist,
`PINCH_KEY`).
