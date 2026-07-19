# Changelog

All notable changes to the claudeconf plugin are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-07-19

Documentation + capability-routing release. The shipped skill now contains the
"Capability routing" section (route by SEMANTIC verifiability — decision-creating
steps stay on the most capable model at maximum reasoning; only
deterministic-verifier-arbitrated fan-out is delegable) and the
doctor-checklist ground rule that the doctor must run on a high-capability model
(false-PASS risk on cheaper models; the profile-4 bundled deterministic checker
is the planned mitigation).

### Changed

- README rewritten for profile 3: the doctor, the suppression-approval flow, the
  post-generation enforcement checklist, the `agentUse` opt-out, and updated
  limitations (configured vs enforced; permissions are not isolation).
- `examples/self-harness/` refreshed to the dev repo's actual profile-3 harness
  (ledger, control-plane CODEOWNERS, `.npmrc` quarantine, digest pins, vendored
  rules, agent-hardening settings, harness scripts); the stale seed
  `semgrep.yml` example removed.
- Plugin/marketplace descriptions mention the harness-doctor agent and the
  supply-chain + agent-hardening layers.
- harness-doctor: explicit note that the agent must run on a high-capability
  model (evidence-sufficiency judgments have no downstream verifier; the
  profile-4 bundled deterministic checker is the planned mitigation).

## [0.3.0] - 2026-07-18

Agent-hardening release (constitution profile 3), designed and adversarially
reviewed with a second-model judge. Generated harnesses are **agent-hardened,
never "agent-proof"** — `configured` and `enforced` are reported separately.

### Added

- **Constitution §4.7 — merge trust root**: independent human control over the
  DERIVED control plane (workflows, hook-runner config, tool configs, manifests,
  lockfiles, scanner excludes, provisioners, the suppression ledger, CODEOWNERS
  itself); suppression additions, broadenings, and config-level weakenings
  require recorded human approval via the **suppression approval ledger**
  (`.claudeconf/suppressions.json` + an occurrence-bound diff checker wired into
  gate and CI — approval is a reviewed ledger edit, never a re-run); `agentUse`
  manifest semantics with a protected opt-out.
- **`references/agent-hardening.md`** — threat model, ledger protocol, the
  editor-side deny module with its residual gaps named (permissions are
  defense-in-depth, not isolation), the bounded SessionStart advisory template,
  and why a blocking Stop hook is rejected as a default.
- **`claudeconf:harness-doctor` agent** + `references/doctor-checklist.md` — an
  evidence-driven, advisory, read-only check procedure validating a harness
  against its recorded profile; `--online` (opt-in, disclosed) adds registry and
  branch-protection probes.
- **Executed-fixture proof**: the dev repo's CI now runs the flagship fixture
  end to end (provisioned pinned tools, fresh temp repo, forced pre-commit, full
  gate, executed-jobs assertion) on every PR.
- **Provisioning module** (`provision-tools.sh` pattern): Linux/x86_64 CI
  provisioning with sha256-verified single binaries; other platforms are
  explicitly "not applicable" (no silent PATH fallback).

### Changed

- **Plugin layout**: the skill moved to `skills/claudeconf/` inside the plugin
  (conventional multi-component layout) alongside the new `agents/` directory.
- Manifest schema (profile 3): `hookRunner` is now `{name, version}`; `agentUse`
  is required; profile checks are keyed by the RECORDED `constitutionVersion`
  ("upgrade available", never "invalid", for older harnesses).

## [0.2.0] - 2026-07-18

Policy & provenance release (constitution profile 2), scoped and adversarially
reviewed with a second-model judge. Theme: recording a version is not the same
as executing it.

### Added

- **Constitution §4.6 — supply-chain admission**: registry dependencies observe a
  release-age quarantine on every resolution/update path the ecosystem supports
  (package-manager minimum-release-age AND updater cooldown); dependency
  lifecycle scripts are denied by default where auditable allowlisting exists;
  exceptions are recorded with an emergency-bypass route. Security updates
  bypass the quarantine.
- **Constitution §6 — versioning & migration**: `constitution-version` is a
  machine-readable conformance profile with explicit bump rules; existing
  harnesses stay valid against their recorded profile ("upgrade available",
  never "invalid"); migration is regenerate → verify → approve → bump.
- **Contract: frozen dependency graphs** — committed lockfiles generated with the
  pinned package manager, frozen installs only (`npm ci`, `uv sync --locked`),
  no fresh-resolution fallback.
- **Contract: workflow auditors** — the CI workflow is itself a supply-chain
  artifact, checked by a pinned syntax auditor + security auditor recorded in
  the manifest's `ci.auditors` (GitHub Actions anchors: actionlint + zizmor,
  blocking at medium severity), run in CI and the local gate.
- **Contract: gate-tier version assertions** for globally-installed hook tools —
  hard-fail on mismatch or unparsable `--version` output.
- **Contract: SAST rules provenance** — `milestones.sast.rules`
  {source, ref, license}; third-party packs need a real source + immutable ref.
- **wiring-principles §8 — "Execute the bits you pinned"**: frozen installs,
  digest-pinned images, version assertions.

### Changed

- Docker-image actions are pinned by immutable `@sha256:` digest — exact tags
  are mutable and no longer acceptable.
- `constitutionVersion` is now `"2"` (consolidates the v0.1.1 tier tightening).
- ci-github-actions.md: `persist-credentials: false` on checkouts, pinned npm
  floor for `min-release-age`, workflow-audit job skeleton.
- node.md / python.md: §4.6 instantiations (npm/pnpm quarantine + script
  controls; uv frozen sync; Dependabot cooldown as Python's quarantine path),
  Biome feature-floor phrasing, prek/ty researched notes.
- security.md: rules-provenance guidance and researched-alternative notes
  (Opengrep, Betterleaks) with an explicit promotion bar.

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

[Unreleased]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/nikolaypaskov/claudeconf-plugin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nikolaypaskov/claudeconf-plugin/releases/tag/v0.1.0
