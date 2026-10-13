# Changelog

All notable changes to the claudeconf plugin are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.2] - 2026-10-13

### Fixed

- **A package runner's scripts are resolved in the directory it names** (harness scripts
  0.6.2, `lib/shell.mjs`). `npm --prefix app run lint`, `pnpm -C app test` and
  `yarn --cwd app build` run the script in that directory's `package.json`. The shared
  resolver read only the root's, so gate ≡ CI (W17) could not identify the tool behind such a
  command, and an enforcing run FAILed a working monorepo harness. The body is now read from
  the named directory, through chains and with arguments after `--`. A directory outside the
  repository is never read, and `npm --prefix app audit` is identified as npm-audit. To take
  the fix, re-vendor `.claudeconf/bin/` and set `harnessScripts.version` to `0.6.2`; the
  catalog keeps 0.6.0 and 0.6.1.

## [0.6.1] - 2026-10-13

### Fixed

- **One provisioned-tools directory per repository** (harness scripts 0.6.1). The vendored
  `provision-tools.mjs` installed every repository's pinned binaries into one machine-wide
  `$TMPDIR/claudeconf-tools`. A second harness on the same machine then refused to provision,
  or overwrote the first with another version of the same tool, so only the repository
  provisioned last could pass its gate. Tools now go to
  `${RUNNER_TEMP:-$TMPDIR}/claudeconf-tools-<key>`, keyed by the repository root's real path.
  `--print-path` and `$GITHUB_PATH` report the new location. To take the fix, re-vendor
  `.claudeconf/bin/` from this bundle, set `harnessScripts.version` to `0.6.1`, and
  re-provision. Harnesses on 0.6.0 still verify, because the catalog keeps its entry. The old
  shared directory is no longer read; delete it.

## [0.6.0] - 2026-10-13

Constitution **profile 6**, "field-first": the harness survives what real projects do to it.
Every version the manifest names is a pin INTO the file that owns it, so a Dependabot bump to a
lockfile passes the gate with no other edit; the support scripts ship in the plugin and are
vendored, never written per project; and a harness is judged at the profile it claimed.

### Added

- **Typed pins** (contract §2.5): `pin: { kind, path, key }` into `package-lock.json`,
  `uv.lock`, `.claudeconf/tools.lock.json`, a hash-locked requirement set, or a version file —
  one fail-closed resolver shared by the checker and every vendored script. New `runtimes`
  (Node required) and `.claudeconf/tools.lock.json` for checksum-provisioned binaries.
- **The vendored support-script bundle**: `skills/claudeconf/scripts/harness/` is copied to a
  harness's `.claudeconf/bin/` — the suppression ledger, the project-check assertion, the
  version assertion, provisioning, and `scan-tree.mjs`, through which the gate's whole-tree
  secret scan reads the INDEX, exactly what CI checks out. The checker verifies the copy
  against `harness-catalog.json` (A17) and requires the gate and CI to run that copy.
- **A3 updater keys**: `semver-*-days` under an ecosystem Dependabot versions without SemVer
  (github-actions, docker, terraform, …) FAILs — the service rejects the whole file.
- **W21**: a required CI check runs on every pull request — no `if:` beyond
  `always()`/`success()`, no repository secret.
- `references/migrations.md` gains the 5 → 6 delta.

### Changed

- **Judgment by claimed profile**: a harness is judged at the highest profile it has recorded,
  targeted, or carried in history; a rule newer than that is INFO, never FAIL. A profile-5
  harness acquires no new failures. The harness-doctor states this in its rules.
- **A12** looks for a tool's config where the harness runs the tool (`root:`,
  `working-directory`, `cd`, `npm --prefix`), so a monorepo running checks from `app/` passes.
- The example is now [`examples/node-app/`](examples/node-app/), the dev repository's profile-6
  exemplar copied verbatim, and CI validates it with the bundled checker instead of a manifest
  shape check.

## [0.5.0] - 2026-08-20

Constitution **profile 5**: the harness now tells the agents working in a project when
delegating is safe.

### Added

- **Delegability record** (`.claudeconf/delegation.md`, constitution §4.7 rule 4). A
  generated, regeneration-owned file stating the two-sided rule — work may go to a less
  capable agent or model only when one of the project's OWN deterministic verifiers decides
  the result, and work whose mistakes could survive every one of them may not — followed by
  that project's actual arbiters, the non-delegable floor, and a plain statement of what the
  record does not establish. Wording is agent-agnostic: it names no vendor's orchestration
  primitives, because a stale instruction read by an agent is worse than no instruction.
- **Two new checks.** `A16` verifies the four required sections exist and carry content;
  `D9` compares the recorded arbiters against the ones the harness actually has, in both
  directions, so a renamed project check or a relocated gate cannot leave the record
  pointing at a verifier that no longer runs.
- **SessionStart advisory reconciliation** (in `A10`, at profile 5): the advisory is a
  second record of the recorded profile, so both interpolated values are now checked against
  the manifest. An unchecked advisory keeps announcing the profile the harness used to be
  at, directly into an agent's context.
- The `harness-doctor` agent reports the record as **declared, never enforced**.

### Changed

- **Profile 4 → 5.** A profile bump rather than an amendment to 4, because §6 bumps on
  required artifacts and archives profiles so an older harness is never judged by rules it
  never claimed. **A profile-4 harness acquires no new failures** — the three new checks are
  level-5, and the upgrade reports as INFO. New failures on a profile-4 harness after taking
  this release would be a checker bug, not a migration you owe.
- `references/migrations.md` gains the `4 → 5` delta; `modes.md` records that a refresh
  touches the record only when the pinned runner path moves.

### Known limits

- The record is a **declared** rule, not a control. The checker verifies the arbiters are
  named correctly; nothing establishes they are sufficient, and no artifact can establish
  that an agent read the file or obeyed it.
- `upgrade` mode still has not been exercised end to end by the skill itself. The 4 → 5
  procedure is written, and the source repository plus all four shipped exemplars were
  migrated by following it — but by hand.

## [0.4.0] - 2026-08-20

Profile 4: an **ownership split** (what a regeneration owns vs what the project owns) and
**verifier-first** conformance (deterministic scripts decide whether a harness conforms,
rather than a model reading it).

The failure this closes is verified, not hypothetical: because the hook runner merges
same-named jobs across config layers, a project-layer job named for a managed one could
disable that check while the merged configuration still showed the correct command — the
run printed the job as skipped and exited 0 green.

### Added
- **A deterministic checker**, `skills/claudeconf/scripts/claudeconf-check.mjs` (~54 check
  ids), plus its vendored YAML parser. This is the first release that ships executable
  code inside the skill. `--enforce` is the default and fails an unverifiable critical
  check; `--advisory` is the doctor's mode and never declares a harness conforming;
  `--profile <n>` dry-runs a target profile IN ADDITION to the recorded one.
- **`references/migrations.md`** — the per-profile delta lists, with the 3→4 procedure's
  two human decision points: classify every existing job, and resolve every managed-name
  collision. Both default to project-owned.
- **`references/modes.md`** — the mechanics of `upgrade` and `refresh`.
- A **project-check assertion** the harness ships into the project in a runtime it already
  has, so a regeneration that drops a project's own check fails instead of passing
  silently.

### Changed
- The harness contract, constitution, wiring principles and agent-hardening notes were
  amended throughout the batch. Several rules that had been stated as closed sets of NAMES
  are now stated as properties — a name is not an identity, and a config value is not a
  resolution.
- `agents/harness-doctor.md` now runs the bundled checker as step 0. The agent is outside
  the skill sync boundary, so this does not carry across on its own.

### Upgrading an existing harness
Ask the skill to upgrade the project; it reads the recorded profile from
`.claudeconf/manifest.json` and applies delta lists one profile at a time (2→4 is 2→3 then
3→4, never merged), verifies by executing both tiers, and bumps `constitutionVersion`
LAST. Run the checker with `--profile 4` first to see the cost without changing anything.

Two things to expect. The upgrade may legitimately fail your harness before it fixes it —
this project's own 3→4 had one profile-3 failure (an unpinned hook runner) that is itself
a profile-4 control, and the procedure carries such a failure in by name. And `upgrade`
mode has not been exercised end to end by the skill itself: both real migrations behind
this release were performed by following `migrations.md` directly.

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
