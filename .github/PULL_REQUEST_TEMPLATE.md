## What & why

<!-- One short paragraph: what changed, why it matters, and `Closes #<issue>` if applicable. -->

## Guardrail check

- [ ] Does this touch `src/tools.js`, `src/risk.js`, `src/guard.js`, `src/store.js`, or `src/mcp.js`? If yes, explain how workspace confinement, approval gates, and zero runtime dependencies still hold.
- [ ] No new runtime dependencies added to `package.json`.

## Verification output

```bash
npm test
npm run audit
node scripts/validate-roadmap.js
```
