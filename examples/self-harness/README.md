# Example: claudeconf's own harness

This is the actual harness `claudeconf` generated for its own repository — a Node/TS
CLI/skill project. It is committed here verbatim as a concrete example of the skill's
output, and the repo's CI runs this exact configuration green.

## Files

- `lefthook.yml` — git hooks across the pre-commit / pre-push / gate tiers (node tools
  invoked via `npx` so project-local binaries resolve).
- `.github/workflows/ci.yml` — CI mirroring the gate tier: SHA-pinned actions,
  least-privilege `permissions`, `concurrency` cancel-in-progress, dependency caching, a
  `dependency-review` job, and a security job (semgrep + trufflehog, pinned images).
- `.github/dependabot.yml` — keeps pinned deps and SHA-pinned actions fresh.
- `.claudeconf/manifest.json` — the recorded tool / version / tier choices (9 milestones,
  all pinned).
- `.claudeconf/semgrep.yml` — the pinned offline SAST ruleset. This is a SEED (a couple
  of patterns), not full coverage; the skill's security guidance covers vendoring a
  curated pack at a pinned commit or adding CodeQL.
- `.claudeconf/trufflehog-exclude.txt` — secret-scan excludes (regexes, incl. `.git/`).
- `.claude/settings.json` — the edit-tier format hook (non-blocking).
- `.editorconfig`, `.gitattributes`, `.github/CODEOWNERS` — repo-hygiene staples.
- `commitlint.config.js` — conventional-commit enforcement, wired at a `commit-msg` hook in `lefthook.yml`.

Nothing here runs claudeconf or Claude — it is plain, pinned tooling you own and can read.
