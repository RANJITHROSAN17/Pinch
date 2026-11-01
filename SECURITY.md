# Security policy

## Reporting a vulnerability

Pinch runs shell commands on your machine for a living, so a real vulnerability
here is worth reporting privately rather than in an issue.

**Use GitHub's private reporting:** [Security → Report a vulnerability](https://github.com/pinchfoundry/Pinch/security/advisories/new).
That opens a draft advisory only you and the maintainer can see.

If you would rather not use GitHub, open an issue that says *only* "security
report, please contact me" with a way to reach you — no details — and a channel
will be arranged.

Please include what you did, what happened, and the version or commit. A probe
script is better than a sentence.

**What to expect:** an acknowledgement within a few days, an honest assessment
of severity, and credit in the advisory once a fix ships. If the answer is
"that is the documented trade-off", the relevant section of
[`docs/AUDIT.md`](docs/AUDIT.md) will be pointed at — the residual-risk register
there is deliberately public.

## Already known and accepted

Read [`docs/AUDIT.md`](docs/AUDIT.md) before reporting. It documents six real
defects that were found by attacking the product, their fixes, and the risks
that remain on purpose:

- the command screen is a denylist, and obfuscated commands still reach the
  approval gate;
- there is no OS-level sandbox — the approval gate and workspace confinement are
  the controls;
- prompt injection through tool output is possible, which is why mutating tools
  are gated;
- the WhatsApp channel is unofficial, against WhatsApp's terms, and off by
  default.

Reporting one of those is still welcome if you can show it is worse than
described — that is exactly how the six got fixed.

## Supported versions

The latest commit on `main`. See [`docs/SUPPORT.md`](docs/SUPPORT.md) for which
Node versions are supported and until when.

## What we will not do

No CVE will be requested for a vulnerability that requires an attacker to already
have local code execution, or that needs the user to approve the destructive
action in the approval gate. That is the threat model, not an oversight.
