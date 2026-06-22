# Security Policy

## Reporting a vulnerability

Report security issues privately via GitHub's **Report a vulnerability** (Security →
Advisories) on this repository, or by email to **n.g.paskov@gmail.com**. Please do not
open a public issue for a vulnerability. Expect an initial response within a few days.

## Scope and honest limits

claudeconf is a Claude Code skill that *generates* a harness; its output is plain,
pinned tooling (lefthook, GitHub Actions, your stack's tools) that runs with no
claudeconf or Claude involvement at runtime.

- **The skill** (`plugins/claudeconf/`) — the generation procedure and reference docs.
- **The generated harness** — the default SAST and secret-scan rulesets are deliberately
  small **seed** rules, not comprehensive coverage. The skill's guidance
  (`references/patterns/security.md`) covers vendoring a curated ruleset at a pinned
  commit (or adding CodeQL), and pairing the local secret scan with **server-side push
  protection**. Local hooks are bypassable (`git commit --no-verify`) and do not scan
  history. Treat a green check as a signal, not a guarantee.

## Determinism by design

The generated security checks run offline and pinned (no `--config auto`, no live
verification) so results are reproducible. This trades some coverage for determinism —
a deliberate, documented choice.
