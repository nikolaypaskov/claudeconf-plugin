# Changelog

All notable changes to the claudeconf plugin are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-17

Correctness release: the skill's docs, examples, and its own harness now agree
with each other everywhere.

### Changed

- **Gate ≡ CI codified** (constitution §1): the gate tier and CI run the same
  full-scope nine-milestone battery; every milestone's default tiers now include
  `gate` + `ci`, and constitution §1 prose matches the §2 table.
- **Canonical SAST config** is the vendored `.claudeconf/rules/` directory; the
  single-file `.claudeconf/semgrep.yml` seed convention is retired.
- **Multi-stack manifests** (harness-contract §2.2.1): milestones served by a
  different tool per stack use a per-stack `tools[]` array; the version rule now
  rejects composite strings ("2.5.0 + 0.15.18") alongside floating ranges.
- **Contract §3.3** checks the full gate battery, file-scoped advisory format
  hooks, and SHA-pinned managed CI blocks with least-privilege permissions.
- security.md: two-scope secret-scan table (changed files at pre-commit,
  whole tree at gate/CI), vendored-dependency-tree excludes (`node_modules/`,
  `.venv/`), and `.claudeconf/rules/` as the canonical semgrep example.
- wiring-principles §4: documents the all-staged-files-ignored hook failure mode
  (e.g. biome `--no-errors-on-unmatched`).
- SKILL.md Step 5 records per-stack `tools[]` for polyglot milestones.

### Fixed

- ci-github-actions.md skeleton: the format step is explicitly advisory
  (`continue-on-error`), and the SAST/secret-scan examples use the pinned
  `.claudeconf/rules/` + `--exclude-paths` conventions.

## [0.1.0] - 2026-06-22

Initial public release — the `claudeconf` skill packaged as a distributable
Claude Code plugin.

### Added

- **`claudeconf` skill** — a research-driven, technology-agnostic generator for a
  pinned quality + security harness (git hooks, CI, e2e, gates) across five tiers
  (`edit → pre-commit → pre-push → gate → CI`) and nine milestones (format, lint,
  typecheck, unit, e2e, SAST, secret-scan, dependency-audit, build). Output is a
  concrete, version-pinned, committed harness that runs with zero claudeconf/Claude
  involvement at runtime.
- **Constitution** (`references/constitution.md`) — the fixed tier ladder, milestone
  gates, and determinism/safety invariants.
- **Harness contract** (`references/harness-contract.md`) — required output artifacts,
  the `.claudeconf/manifest.json` schema, and the self-verify checklist (including the
  gate-tier executable run).
- **Wiring principles** (`references/wiring-principles.md`) — seven technology-agnostic
  correctness rules: hook tool resolution, coverage providers, CI runner/setup matching
  the stack, formatter/scanner scoping, whole-tree scanner VCS excludes, verify-by-
  executing, and registry-existence checks (anti-slopsquatting).
- **Thin per-stack anchors** (`references/patterns/`) — optional starting points for
  node, python, elixir, swift, and kotlin, plus security, GitHub Actions CI, and
  interface-first e2e.
- **Supply-chain hardening** — SHA-pinned GitHub Actions, least-privilege `permissions`,
  a `dependency-review` PR gate, and a Dependabot config (the upgrade path) as required
  output.
- **Repo-hygiene staples** — `.editorconfig`, `.gitattributes`, CODEOWNERS, and
  commitlint (`commit-msg`) in the generated harness.
- **Honest security posture** — the default SAST and secret-scan rulesets are documented
  as seed rules (with the path to credible coverage), not overstated.
- **Proof and trust** — a vendored, CI-validated example of the generated harness, a CI
  badge, SECURITY and CONTRIBUTING docs, and issue/PR templates.
- Self-hosted marketplace manifest, MIT license, and README.

[Unreleased]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nikolaypaskov/claudeconf-plugin/releases/tag/v0.1.0
