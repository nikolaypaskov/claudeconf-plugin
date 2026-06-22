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
| **CI workflow** | `.github/workflows/ci.yml` | Must mirror the gate tier. Authoritative pass/fail signal for pull requests. SHA-pin every action (constitution §4.1). |
| **Dependency-update config** | `.github/dependabot.yml` OR `renovate.json` | The upgrade path for a pin-everything harness — keeps pinned deps and SHA-pinned actions fresh. Covers the project's package ecosystem(s) + `github-actions`. |
| **Edit-tier hook** | Entry in `.claude/settings.json` (hook block) | Wires the `format` milestone into Claude Code's edit hook. Non-blocking, silent on success. Must also include a scope guard entry if the harness is generated for a pentest engagement. |
| **E2E scaffold + config** | e2e suite directory + framework config file (suite path fits the project's interface — `e2e/` for a UI, the integration-test dir for a CLI/service) | Must run unattended with no live external credentials. Framework + suite recorded in manifest. |
| **Pinned tool configs** | One config file per tool used by a milestone | e.g. `biome.json`, `vitest.config.ts`, `playwright.config.ts`, `.semgrep.yml`. Each config pins the tool version via the project lock file or an explicit version field. |
| **Repo hygiene** | `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), `.github/CODEOWNERS` | Baseline staples: consistent editor settings, normalized line endings (protects the determinism invariant), and code ownership. After generation, print a checklist to enable branch protection / required status checks — the harness can scaffold files but not change GitHub settings. |
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
  "constitutionVersion": "1",
  "generator": "claudeconf-skill",
  "stacks": ["node"],
  "hookRunner": "lefthook",
  "milestones": {
    "format":          { "tool": "biome",     "version": "2.5.0", "tiers": ["edit"] },
    "lint":            { "tool": "biome",     "version": "2.5.0", "tiers": ["pre-commit"] },
    "typecheck":       { "tool": "tsc",       "version": "x.y.z", "tiers": ["pre-commit"] },
    "unit":            { "tool": "vitest",    "version": "x.y.z", "tiers": ["pre-commit","pre-push"] },
    "e2e":             { "tool": "playwright","version": "x.y.z", "tiers": ["gate","ci"] },
    "sast":            { "tool": "semgrep",   "version": "x.y.z", "tiers": ["pre-push","ci"] },
    "secret-scan":     { "tool": "trufflehog","version": "x.y.z", "tiers": ["pre-commit"] },
    "dependency-audit":{ "tool": "npm-audit", "version": "n/a",   "tiers": ["pre-push","ci"] },
    "build":           { "tool": "tsup",      "version": "x.y.z", "tiers": ["pre-push","ci"] }
  },
  "ci": { "provider": "github-actions", "workflow": ".github/workflows/ci.yml" },
  "e2e": { "framework": "playwright", "suite": "e2e/" }
}
```

### 2.3 Field rules

| Field | Rule |
| --- | --- |
| `constitutionVersion` | MUST match the version heading in `constitution.md`. Currently `"1"`. |
| `generator` | Fixed string `"claudeconf-skill"`. |
| `stacks` | One or more stack identifiers detected by the skill. Non-empty array. |
| `hookRunner` | `"lefthook"` (default) or the ecosystem-standard runner name. |
| `milestones` | MUST contain exactly the nine milestone keys listed in §2.2. No milestone may be absent. |
| `milestones[*].tool` | Exact tool name used. |
| `milestones[*].version` | Exact pinned version string (or `"n/a"` for tools that version through the runtime, e.g. `npm-audit`). Floating ranges are forbidden. |
| `milestones[*].tiers` | Non-empty array. Each entry must be one of: `"edit"`, `"pre-commit"`, `"pre-push"`, `"gate"`, `"ci"`. Must cover at least the default tier(s) from constitution §2. |
| `ci.workflow` | Path to the CI workflow file, relative to the repository root. |
| `e2e.suite` | Path to the e2e suite directory, relative to the repository root. |

---

## 3. Self-Verify Checklist

After generating all artifacts the skill MUST run through this checklist in order.
Any failing check aborts with an actionable error message; the harness is NOT
considered complete until all checks pass.

### 3.1 Manifest completeness

- [ ] `.claudeconf/manifest.json` exists and is valid JSON.
- [ ] All nine milestone keys are present: `format`, `lint`, `typecheck`, `unit`,
  `e2e`, `sast`, `secret-scan`, `dependency-audit`, `build`.
- [ ] Every milestone entry has a non-empty `tool` field.
- [ ] Every milestone entry has a `version` field that is not a floating range
  (must not match `/[\^~><=*xX]/` except for the literal string `"n/a"`).
  Wildcard version segments such as `5.x` or `1.X` are NOT valid pinned versions.
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

### 3.3 Milestone wiring

- [ ] Every milestone listed in `milestones` is wired into every tier in its
  `tiers` array — i.e. the git-hook config has an entry for each `pre-commit` /
  `pre-push` milestone, and the CI workflow has a step for each `ci` milestone.
- [ ] The `format` milestone is wired into the `.claude/settings.json` edit hook
  and NOT into the git-hook config's blocking tiers (it is advisory-only at edit).
- [ ] The `e2e` milestone is present in the CI workflow and in the gate tier of
  the git-hook config (or a separate gate script).
- [ ] Supply-chain hardening of the CI workflow: every `uses:` is pinned to a full
  40-character commit SHA (not a tag like `@v4`); docker-image actions are pinned by an
  exact image tag; the workflow sets a least-privilege top-level `permissions:` block
  (`contents: read`, escalated per-job only as needed). (Constitution §4.1.)

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
| §5 Hook-Runner Rule | §2.3 `hookRunner` field; §1 git-hook config note |
