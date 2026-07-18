# claudeconf Harness Contract

This document is the OUTPUT specification for the claudeconf skill. It defines the
exact artifacts a generated harness MUST produce, the `.claudeconf/manifest.json`
schema, and the self-verify checklist the skill runs after generation. It is consumed
by SKILL.md (the skill procedure) and must remain consistent with the invariants in
`constitution.md`.

---

## 1. Required Output Artifacts

A generated harness MUST produce ALL of the following artifacts. Omitting any one is
a contract violation; the skill must abort with an error listing the missing artifact.

| Artifact | Path (project-relative) | Notes |
| --- | --- | --- |
| **Git-hook config** | `lefthook.yml` OR `.pre-commit-config.yaml` | Default is `lefthook.yml`. An ecosystem-standard runner may be used only when all three criteria in constitution §5 are satisfied. |
| **CI workflow** | `.github/workflows/ci.yml` | Must mirror the gate tier. Authoritative pass/fail signal for pull requests. SHA-pin every action; docker-image actions by `@sha256:` digest (constitution §4.1). The workflow is itself a supply-chain artifact: it must be checked by a PINNED syntax auditor and a PINNED security auditor for the CI provider (recorded in the manifest's `ci.auditors`; for GitHub Actions the current researched anchors are actionlint + zizmor — see `patterns/ci-github-actions.md`). |
| **Dependency-update config** | `.github/dependabot.yml` OR `renovate.json` | The upgrade path for a pin-everything harness — keeps pinned deps and SHA-pinned actions fresh. Covers the project's package ecosystem(s) + `github-actions`, and includes a release-age **cooldown** block (constitution §4.6). Pair it with the package manager's own minimum-release-age setting where the ecosystem has one — updater-side cooldown alone leaves the install path open. |
| **Dependency lockfile + frozen installs** | The ecosystem's lockfile (`package-lock.json`, `pnpm-lock.yaml`, `uv.lock`, `Gemfile.lock`, …) | Committed wherever the ecosystem supports one, generated with the pinned package-manager version. Every install in hooks/CI uses the FROZEN mode (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`, …) with NO fallback to fresh resolution — `npm ci \|\| npm install` silently re-resolves the tree (constitution §4.3/§4.6). |
| **Edit-tier hook** | Entry in `.claude/settings.json` (hook block) | Wires the `format` milestone into Claude Code's edit hook. Non-blocking, silent on success. Must also include a scope guard entry if the harness is generated for a pentest engagement. |
| **E2E scaffold + config** | e2e suite directory + framework config file (suite path fits the project's interface — `e2e/` for a UI, the integration-test dir for a CLI/service) | Must run unattended with no live external credentials. Framework + suite recorded in manifest. |
| **Pinned tool configs** | One config file per tool used by a milestone | e.g. `biome.json`, `vitest.config.ts`, `playwright.config.ts`, and the vendored SAST ruleset directory `.claudeconf/rules/` (pinned rule files committed into the repo — see `patterns/security.md`). Each config pins the tool version via the project lock file or an explicit version field. |
| **Repo hygiene** | `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), `.github/CODEOWNERS` | Baseline staples: consistent editor settings, normalized line endings (protects the determinism invariant), and code ownership. After generation, print a checklist to enable branch protection / required status checks (rulesets preferred). A generated ruleset JSON is OPTIONAL desired-state input that a human must review and import — its existence never implies protection is applied; the harness cannot change GitHub settings. |
| **Suppression approval ledger** | `.claudeconf/suppressions.json` + a check script (e.g. `scripts/check-suppressions.mjs`) wired into gate + CI | The human-approval path for silencing a control (constitution §4.7.2). The ledger records `{fingerprint, file, rule, rationale}` per approved suppression. The check diffs against the merge base and FAILS on any added or BROADENED suppression token, or any widened config-level exclusion (scanner exclude files, ignore configs), that lacks a ledger entry. Approval = a reviewed merge of the ledger change itself — the ledger sits on the protected surface, so a code-owner review of it IS the sign-off. |
| **Control-plane ownership** | Entries in `.github/CODEOWNERS` (GitHub implementation of §4.7.1) | Ownership entries for the DERIVED protected surface: CI workflows, hook-runner config, tool configs, manifests + lockfiles, scanner exclude/ignore files, provisioning scripts + checksums, the suppression ledger, and CODEOWNERS itself. CONFIGURED only — the post-generation checklist names the `enforced` bar: branch rules requiring code-owner approval, dismissing stale reviews, requiring approval of the latest push, and no bypass actors. Never claim `enforced` from the file's existence. |
| **Agent-hardening module** (`agentUse: true`) | `permissions.deny` entries + a `SessionStart` advisory hook in `.claude/settings.json` | Default-on runtime hardening: deny rules hide secret-bearing paths from the agent (defense-in-depth, NOT isolation — see `agent-hardening.md` for residual gaps), and the SessionStart hook injects a bounded, schema-validated one-liner: declared profile + the runner-specific gate command ("declared", never "verified"). No Stop hook by default (see agent-hardening.md — experimental opt-in only). |
| **Manifest** | `.claudeconf/manifest.json` | See §2 for the complete schema. |

### 1.1 Scope guard (pentest context only)

When the harness is generated for a security or pentest engagement, the `.claude/settings.json`
edit hook must include a scope-guard wrapper that reads `.scope` from the repository
root and refuses to invoke any network-aware tool against a target that falls outside
the listed entries. See constitution §4.5 for the scope file format.

---

## 2. Manifest Schema

The manifest records every tool choice made at generation time so the harness is
reproducible and auditable.

### 2.1 Determinism rule

**The manifest has NO volatile fields — no timestamps, no wall-clock dates, no random
seeds.** Re-running the skill against the same project with the same choices (stacks,
hook runner, tool versions) must yield a byte-identical `.claudeconf/manifest.json`.
This is the determinism invariant from constitution §4.3.

**Scope of the claim — be precise.** Determinism is a property of (a) the generated
harness AT RUNTIME and (b) the manifest GIVEN a fixed set of tool choices. It is NOT a
claim that the generation step is reproducible: the tool/version choices come from live
research, so a run weeks later may legitimately pick a newer "latest stable" version or
a different tool. That is an UPGRADE, not a determinism violation — record it as a
deliberate change; do not present generation itself as byte-stable.

### 2.2 Required schema (example values; tool versions are filled in at generation time)

```json
{
  "constitutionVersion": "3",
  "generator": "claudeconf-skill",
  "agentUse": true,
  "stacks": ["node"],
  "hookRunner": { "name": "lefthook", "version": "x.y.z" },
  "milestones": {
    "format":          { "tool": "biome",     "version": "2.5.0", "tiers": ["edit","gate","ci"] },
    "lint":            { "tool": "biome",     "version": "2.5.0", "tiers": ["pre-commit","gate","ci"] },
    "typecheck":       { "tool": "tsc",       "version": "x.y.z", "tiers": ["pre-commit","gate","ci"] },
    "unit":            { "tool": "vitest",    "version": "x.y.z", "tiers": ["pre-commit","pre-push","gate","ci"] },
    "e2e":             { "tool": "playwright","version": "x.y.z", "tiers": ["gate","ci"] },
    "sast":            { "tool": "semgrep",   "version": "x.y.z", "tiers": ["pre-push","gate","ci"],
                         "rules": { "source": "hand-authored", "ref": "n/a", "license": "MIT" } },
    "secret-scan":     { "tool": "trufflehog","version": "x.y.z", "tiers": ["pre-commit","gate","ci"] },
    "dependency-audit":{ "tool": "npm-audit", "version": "n/a",   "tiers": ["pre-push","gate","ci"] },
    "build":           { "tool": "tsup",      "version": "x.y.z", "tiers": ["pre-push","gate","ci"] }
  },
  "ci": {
    "provider": "github-actions",
    "workflow": ".github/workflows/ci.yml",
    "auditors": [
      { "tool": "actionlint", "version": "x.y.z" },
      { "tool": "zizmor",     "version": "x.y.z" }
    ]
  },
  "e2e": { "framework": "playwright", "suite": "e2e/" }
}
```

Every milestone's `tiers` includes `gate` and `ci` — the Gate ≡ CI rule
(constitution §1).

### 2.2.1 Multi-stack milestones (polyglot projects)

When one milestone is served by a DIFFERENT tool per stack, the entry uses a
per-stack `tools` array INSTEAD of the top-level `tool`/`version` pair. Never join
tools or versions into one string (`"biome + ruff"` is malformed):

```json
"lint": {
  "tools": [
    { "stack": "node",   "tool": "biome", "version": "2.5.0"   },
    { "stack": "python", "tool": "ruff",  "version": "0.15.18" }
  ],
  "tiers": ["pre-commit","gate","ci"]
}
```

Each `tools[]` element obeys the same `tool`/`version` field rules as a single-tool
entry. `e2e.framework` follows the same principle (an array of
`{ "stack", "framework" }` objects), and `e2e.suite` may be an array of suite paths —
one per stack.

### 2.3 Field rules

| Field | Rule |
| --- | --- |
| `constitutionVersion` | MUST match the machine-readable `constitution-version` marker at the top of `constitution.md`. Currently `"3"` (see constitution §6 for bump/migration semantics; validators keep older profiles' checks and validate a harness against its RECORDED profile). |
| `agentUse` | Boolean, default `true` (constitution §4.7). `false` requires an `agentUseRationale` string, may be chosen only at the generation human-review gate, and disables every agent-hardened claim. Changing the value later is a control-plane change (§4.7.3). |
| `generator` | Fixed string `"claudeconf-skill"`. |
| `stacks` | One or more stack identifiers detected by the skill. Non-empty array. |
| `hookRunner` | Object `{ "name", "version" }` — the runner (default `"lefthook"`, or the ecosystem-standard runner per constitution §5) and its exact pinned version. A doctor cannot verify what it cannot identify; a bare name is a profile-2 form. |
| `milestones` | MUST contain exactly the nine milestone keys listed in §2.2. No milestone may be absent. |
| `milestones[*].tool` | Exact tool name used. A single-tool entry has `tool` + `version`; a multi-stack entry has `tools[]` instead (§2.2.1) — never both, never a joined string. |
| `milestones[*].version` | Exact pinned version string (or `"n/a"` for tools that version through the runtime, e.g. `npm-audit`). Floating ranges are forbidden, and so are composite strings — a version must not contain spaces or `+`. Applies to every `tools[]` element too. |
| `milestones[*].tiers` | Non-empty array. Each entry must be one of: `"edit"`, `"pre-commit"`, `"pre-push"`, `"gate"`, `"ci"`. Must cover at least the default tier(s) from constitution §2 (which include `gate` + `ci` for every milestone). |
| `ci.workflow` | Path to the CI workflow file, relative to the repository root. |
| `ci.auditors` | Non-empty array of `{ "tool", "version" }` — the pinned SYNTAX auditor and SECURITY auditor for the CI provider's workflow format (constitution §4.1 applied to the workflow itself). Versions obey the same pin rules as milestones. Auditors are recorded here, never as a tenth milestone. |
| `milestones.sast.rules` | OPTIONAL provenance for the vendored SAST ruleset: `{ "source", "ref", "license" }`. Rules copied from a third-party pack MUST record the real source URL and an immutable commit `ref`; `"source": "hand-authored"` + `"ref": "n/a"` are valid ONLY for rules authored in this repository — never as an escape hatch for vendored content. |
| `e2e.suite` | Path to the e2e suite directory, relative to the repository root — or an array of paths for a multi-stack project (§2.2.1). |

---

## 3. Self-Verify Checklist

After generating all artifacts the skill MUST run through this checklist in order.
Any failing check aborts with an actionable error message; the harness is NOT
considered complete until all checks pass.

### 3.1 Manifest completeness

- [ ] `.claudeconf/manifest.json` exists and is valid JSON.
- [ ] All nine milestone keys are present: `format`, `lint`, `typecheck`, `unit`,
  `e2e`, `sast`, `secret-scan`, `dependency-audit`, `build`.
- [ ] Every milestone entry has a non-empty `tool` field, or a non-empty `tools[]`
  array whose every element has non-empty `stack` + `tool` (multi-stack form, §2.2.1).
- [ ] Every `version` (top-level and inside `tools[]`) is not a floating range or a
  composite (must not match `/[\^~><=*xX+ ]/` except for the literal string `"n/a"`).
  Wildcard segments such as `5.x` and joined strings such as `"2.5.0 + 0.15.18"` are
  NOT valid pinned versions.
- [ ] Every milestone's tool+version pair is CONFIRMED to exist on its registry (e.g.
  `npm view <pkg>@<version> version`), not merely well-formed. A pinned name/version
  that cannot be confirmed is a hard error — it may be a hallucinated or squattable
  package (`wiring-principles.md` §7).
- [ ] Every milestone entry has a non-empty `tiers` array covering at least the
  default tiers from constitution §2.

### 3.2 Artifact existence

- [ ] Git-hook config exists: `lefthook.yml` OR `.pre-commit-config.yaml`.
- [ ] CI workflow exists: `.github/workflows/ci.yml`.
- [ ] `.claude/settings.json` contains an edit-tier hook entry for the `format`
  milestone.
- [ ] If pentest context: `.claude/settings.json` hook also contains a scope-guard
  wrapper; `.scope` file exists at the repository root.
- [ ] E2E scaffold exists: the suite directory recorded in `manifest.e2e.suite`
  is non-empty and contains at least one test file.
- [ ] Pinned tool configs exist for every tool referenced in the manifest.
- [ ] Dependency-update config exists (`.github/dependabot.yml` or `renovate.json`)
  and contains a cooldown block (constitution §4.6).
- [ ] The ecosystem lockfile is committed (where the ecosystem supports one), and
  every install command in hooks/CI uses the frozen mode with no fresh-resolution
  fallback.
- [ ] Repo-hygiene staples exist: `.editorconfig`, `.gitattributes`,
  `.github/CODEOWNERS`.
- [ ] The whole-tree scanner exclude file exists (e.g.
  `.claudeconf/trufflehog-exclude.txt`) and covers VCS metadata + vendored trees.
- [ ] `.claudeconf/suppressions.json` exists (empty array is valid) and its check
  script is wired into the gate AND CI (§4.7.2).
- [ ] CODEOWNERS carries ownership entries for the full derived control plane —
  including the suppression ledger and CODEOWNERS itself (§4.7.1).
- [ ] With `agentUse: true`: `.claude/settings.json` contains the
  `permissions.deny` module and the SessionStart advisory hook; the manifest has
  no Stop hook wired by default.
- [ ] The post-generation output states `configured` vs `enforced` separately and
  prints the enforcement checklist (code-owner approval, dismiss stale, latest
  push, no bypass) without claiming any of it is active.

### 3.3 Milestone wiring

- [ ] Every milestone listed in `milestones` is wired into every tier in its
  `tiers` array — i.e. the git-hook config has an entry for each `pre-commit` /
  `pre-push` milestone, and the CI workflow has a step for each `ci` milestone.
- [ ] The gate group carries the FULL battery (Gate ≡ CI, constitution §1): format
  check, lint, typecheck, unit + coverage, e2e, SAST, whole-tree secret scan,
  dependency audit, build — the same set the CI workflow runs.
- [ ] The `format` milestone is wired into the `.claude/settings.json` edit hook
  (file-scoped autofix on the edited file — never a whole-project reformat) and is
  advisory at every tier: NOT in the git-hook config's blocking pre-commit/pre-push
  groups, and non-blocking in gate/CI check mode (`|| true` /
  `continue-on-error: true`).
- [ ] The `e2e` milestone is present in the CI workflow and in the gate tier of
  the git-hook config (or a separate gate script).
- [ ] Supply-chain hardening of the CI workflow: every `uses:` is pinned to a full
  40-character commit SHA (not a tag like `@v4`); docker-image actions are pinned by
  an immutable `@sha256:` DIGEST — an exact tag is mutable and not acceptable; a
  trailing comment records the human-readable version. The workflow sets a
  least-privilege top-level `permissions:` block (`contents: read`, escalated
  per-job only as needed). (Constitution §4.1.)
- [ ] Every `ci.auditors` entry is wired: the pinned workflow syntax auditor and
  security auditor run against the CI workflow in CI itself AND in the local gate
  (malformed YAML must be caught before the workflow is the thing that can't run).

### 3.4 Executable run — pre-commit AND gate tiers

- [ ] The pre-commit hook runs with every command ACTUALLY EXECUTED — not
  skipped — and exits 0. A run on a clean working tree with no staged changes is
  NOT sufficient: file-scoped commands (lint, unit, secret-scan) skip when
  nothing is staged, so the hook exits 0 without invoking a single tool and
  confirms nothing about tool resolution. Force real execution instead — run the
  hook against a representative staged file, or use the runner's all-files form
  (`lefthook run pre-commit --all-files`, or `--force`) — and confirm every
  command runs and exits 0 with NO `command not found` / exit 127. This is what
  actually confirms all hook commands are resolvable and no tool is missing from
  `PATH` (e.g. project-local devDeps that must be invoked via `npx` /
  `node_modules/.bin` — see the stack patterns).
- [ ] The GATE-tier command set runs green locally — the full whole-repo
  commands CI mirrors: whole-tree format/lint, full typecheck, unit + COVERAGE,
  e2e, SAST, whole-tree secret-scan, and build. The pre-commit run above is
  staged-scoped and does NOT exercise these, so CI-only failures hide here: the
  coverage provider may be missing, a whole-repo formatter can hit generated or
  nested configs, and a whole-tree secret scan (incl. CI's injected `.git`
  checkout token) behaves unlike the changed-files scan. Run the gate sequence
  (e.g. `lefthook run gate`, or each CI command) and confirm exit 0 BEFORE the
  human-review gate — surface CI failures now, not on first push.
- [ ] The gate includes a VERSION-ASSERTION step for every globally-installed tool
  the hooks invoke by bare name (scanners, auditors): parse `tool --version` and
  hard-fail on a mismatch with the manifest pin OR on unparsable output. This is
  version ENFORCEMENT, not binary provenance — it proves the executing binary is
  the recorded version, closing the "recorded 1.2.3, executing 1.4.0" gap.
  (Checksum/Sigstore-pinned provisioning is the stronger bar, tracked for a later
  profile.)

### 3.5 Idempotency (no-op re-generation)

- [ ] Re-running the skill with identical inputs produces no file changes.
  Concretely: after generation, running the skill again must leave `git status`
  clean (no new or modified files). This enforces constitution §4.4. "Identical
  inputs" includes the resolved tool versions: if upstream has since shipped a newer
  version, a re-run that picks it up will (correctly) change the manifest — that is an
  upgrade, not an idempotency failure. Idempotency is about the writer not duplicating
  or churning managed blocks for the SAME inputs.

---

## 4. Relationship to the Constitution

This contract operationalises the constitution:

| Constitution section | Contract section |
| --- | --- |
| §1 Tier Ladder | §2.3 `milestones[*].tiers` field rules; §3.3 milestone wiring |
| §2 Milestone Gates | §2.2 nine required milestone keys; §3.1 manifest completeness |
| §3 Non-Negotiables | §1 required artifacts (CI workflow, e2e scaffold) |
| §4.1 Pinned versions | §2.3 version field rules; §3.1 version check |
| §4.3 Deterministic | §2.1 determinism rule (no volatile fields) |
| §4.4 Idempotent | §3.5 no-op re-generation check |
| §4.5 Scope guard | §1.1 scope guard artifact; §3.2 scope guard existence check |
| §4.6 Supply-chain admission | §1 dependency-update + lockfile rows; §3.2 cooldown/lockfile checks |
| §4.7 Merge trust root | §1 suppression-ledger + control-plane + agent-hardening rows; §2.3 `agentUse`; §3.2 ledger/ownership checks |
| §5 Hook-Runner Rule | §2.3 `hookRunner` field; §1 git-hook config note |
| §6 Versioning & Migration | §2.3 `constitutionVersion` field rule |
