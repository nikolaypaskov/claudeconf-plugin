# Example: claudeconf's own harness

This is the actual harness `claudeconf` maintains for its own development
repository — a Node/TS skill project at **constitution profile 3**. It is
committed here verbatim as a concrete example of the skill's output, and the dev
repo's CI runs this exact configuration green on every PR.

## Files

- `lefthook.yml` — git hooks across pre-commit / pre-push / gate. The gate is the
  full battery (Gate ≡ CI): tool-version assertions, workflow audit
  (actionlint + zizmor), the suppression-ledger check, format check, lint,
  typecheck, unit + coverage, e2e, SAST, whole-tree secret scan, dependency
  audit, build.
- `.github/workflows/ci.yml` — CI mirroring the gate: SHA-pinned actions, docker
  images pinned by `@sha256:` digest, least-privilege `permissions`,
  `persist-credentials: false`, `concurrency`, frozen `npm ci`, a
  `dependency-review` job, the security job, a `workflow-audit` job, and
  `fixture-exec` (this repo's eval fixture executed end to end — repo-specific;
  a generated harness for YOUR project won't have it).
- `.github/dependabot.yml` — pinned-dep + SHA-pin upgrades with a release-age
  `cooldown` (constitution §4.6).
- `.npmrc` — install-path quarantine (`min-release-age`) with an
  `engine-strict` npm floor; script-control limitation recorded.
- `.claudeconf/manifest.json` — the recorded contract: profile `3`, `agentUse`,
  `hookRunner {name, version}`, nine pinned milestones, `ci.auditors`, SAST
  rules provenance.
- `.claudeconf/rules/` — the vendored, pinned offline SAST ruleset (a SEED —
  the security guidance covers vendoring a curated pack or adding CodeQL).
- `.claudeconf/trufflehog-exclude.txt` — secret-scan excludes (regexes; `.git/`,
  lockfiles, vendored trees).
- `.claudeconf/suppressions.json` — the suppression approval ledger
  (constitution §4.7.2; empty here — no approved suppressions).
- `.claude/settings.json` — the file-scoped edit-tier format hook, the
  agent-hardening `permissions.deny` module, and the bounded SessionStart
  advisory.
- `.github/CODEOWNERS` — default ownership plus the derived control-plane
  entries (§4.7.1; `configured` — enforcement needs branch rules).
- `scripts/` — `assert-tool-versions.sh` (gate version enforcement),
  `check-suppressions.mjs` (the ledger gate), `provision-tools.sh`
  (Linux/x86_64 CI provisioning, checksum-verified binaries), and
  `validate-fixtures.mjs` (repo-specific eval validation).
- `.editorconfig`, `.gitattributes`, `commitlint.config.js` — hygiene staples +
  conventional commits at `commit-msg`.

Nothing here runs claudeconf or Claude — it is plain, pinned tooling you own and
can read.
