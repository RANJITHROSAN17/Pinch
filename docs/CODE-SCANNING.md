# Code-scanning findings and repository-policy limits

This records the triage of the three open alerts reported against `main` at
`4dff678554064f808486f4a82c1aa0b24872ab28`. It is a snapshot, not a claim that future
scans will be clean or that the project is vulnerability-free.

## Source findings addressed in this change

| Alert | Finding | Change | Regression coverage |
|---|---|---|---|
| [56](https://github.com/pinchfoundry/Pinch/security/code-scanning/56) | `js/trivial-conditional` in Telegram reply formatting | The header-shrinking loop always truncates, so it now appends the ellipsis directly instead of assigning `true` and immediately testing it. The initial, conditional ellipsis remains necessary. | Exact 400-character serialized boundary; one character over; valid JSON escaping for quotes, backslashes and control characters; supplementary Unicode; unchanged incoming body. |
| [55](https://github.com/pinchfoundry/Pinch/security/code-scanning/55) | `js/unused-local-variable`: unused `readJson` helper in exports | Remove the unused helper. Actual store loading and telemetry parsing remain unchanged. | Existing export/corrupt-session tests plus malformed telemetry lines, preserved valid records, missing optional telemetry and default telemetry exclusion. |

These are CodeQL correctness/maintainability findings, not confirmed exploitable
vulnerabilities. The changes preserve intended behavior; the new tests pin that
behavior rather than claim to reproduce an exploit. No query is disabled and no
alert is manually dismissed. A successful PR analysis validates the proposed
source revision; default-branch alert closure requires merge and a subsequent
`main` analysis.

## Alert 1: branch protection — intentionally still open

[OpenSSF Scorecard's Branch-Protection finding](https://github.com/pinchfoundry/Pinch/security/code-scanning/1)
is a repository-governance setting, not a JavaScript defect. Changing source alone
cannot resolve it.

An authenticated inspection found:

- `main` already has required, up-to-date CI checks and one required approving
  review. Force pushes and branch deletion are prohibited.
- Classic branch protection has stale-review dismissal enabled, but administrator
  enforcement and last-push approval are disabled.
- An additional active ruleset has stale-review dismissal disabled and requires
  code-owner review, but there is no `CODEOWNERS` file. It also has role/app/deploy-key
  bypasses. The two configurations should be reviewed together, not inferred from
  one historical scanner message.
- Only one collaborator currently has write/admin access. Other collaborators do
  not have the access needed for independent required approvals.

The owner explicitly chose to retain the current practical merge policy and
**defer stricter governance**, rather than silently block merges by removing the
only maintainer's bypass. This change does not modify protection settings,
collaborator access, bypass actors, Scorecard thresholds or alert state. The
remaining finding is not dismissed, suppressed or called fixed.

### Before tightening the policy

1. Identify trusted independent reviewers and explicitly agree their repository
   access. Do not grant permissions merely to improve a scanner score.
2. Create a `CODEOWNERS` file using real, eligible reviewers or teams; verify their
   access and review availability. A sole author's name does not create independent
   review of that author's PRs.
3. Reconcile classic protection and rulesets: stale-review dismissal, last-push
   approval, required checks, review count, code-owner coverage and intentional
   exceptions. Review bypass permissions individually rather than deleting them
   without understanding automation and recovery requirements.
4. If the project chooses the highest Scorecard tier, arrange at least two eligible
   independent approvals and administrator enforcement. Accept the operational
   cost before applying those requirements.
5. Test the proposed policy with a harmless PR, retain an administrative recovery
   path, then rerun Scorecard on the default branch and inspect its actual result.

The goal is an enforceable review process, not a cosmetic green dashboard.
