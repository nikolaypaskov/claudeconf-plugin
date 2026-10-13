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
| **Git-hook config** (split by OWNERSHIP) | `.claudeconf/lefthook.yml` (fully managed) **+** `lefthook.yml` (project-owned) | Default runner is lefthook (constitution §5). `.claudeconf/lefthook.yml` holds EVERY generated hook, and every top-level runner setting the runner MERGES across `extends` (see the runner-pinning paragraph below — a setting the runner does not merge belongs in the root file's managed block instead, because a setting written where the runner never reads it is not a setting), carries a header comment saying it is generated and rewritten wholesale on re-run, and contains no sentinels — the whole file is the managed region. The root `lefthook.yml` is PROJECT-OWNED and carries exactly ONE managed block whose only content is an `extends` list containing `.claudeconf/lefthook.yml`; a re-run rewrites that block in place and PRESERVES foreign entries already in the list. Project-owned jobs go BELOW the block and are declared in `projectChecks` (§2.3) so a regeneration that loses one is loud. Managed and project-owned names may not collide (§2.4) and the merged result must be field-identical to the managed declaration (§3.3). The harness also PINS THE RUNNER with three settings: `lefthook: <pinned runner path>` (the path the shim consults before `PATH`), `assert_lefthook_installed: true` (a missing runner aborts the hook instead of printing a notice and exiting 0), and `min_version` equal to the manifest's `hookRunner.version`. **A runner setting must be written where the runner actually READS it, which is not necessarily the managed file.** Verified against lefthook 2.1.9: `assert_lefthook_installed` and `min_version` DO merge across `extends`, and `lefthook:` DOES NOT — it is absent from the merged dump, so a harness that pins the path only in the managed file runs every hook through whatever `PATH` supplies. Settings the runner does not merge therefore go in the ROOT file's managed block alongside the `extends` list, which is why that block is defined by ownership rather than by content. Determine mergeability BY EXECUTION for the runner and version in hand — never from documentation, and never by assuming the split behaves uniformly. Every stack needs a pinned runner path; where the ecosystem cannot provide one the manifest records `runnerPinned: false` with a rationale (§2.3) rather than implying a control that does not exist. These three values are baked into `.git/hooks/*` at install time, so ANY change to them requires re-running the runner's `install` — the post-generation checklist says so. `.pre-commit-config.yaml` may replace lefthook only when all three criteria in constitution §5 hold; it has no `extends`, so it keeps the single-file managed-region model and `projectChecks` alone protects project-owned checks. That is a recorded asymmetry, not an exemption. |
| **Project-check assertion** | Profile 6: the vendored `.claudeconf/bin/check-project-checks.mjs` (see *Vendored support scripts*). Profile ≤5: `scripts/check-project-checks.<ext>` — the extension of a runtime one of the manifest's `stacks[]` ALREADY requires (`.mjs` for a `node` stack, `.py` for a `python` stack) — plus a `project-checks` job in the managed gate and a `project-checks` step in the managed CI workflow | REQUIRED even when `projectChecks` is empty, so declaring a check later needs no rewiring. It reads the manifest and proves every declared check still resolves at every tier it claims: for `pre-commit`/`pre-push`/`gate`, a job of that name in the MERGED hook config; for `ci`, a job id or step name in `manifest.ci.workflow`. The entry's `run` substring must appear in an EXECUTED position of the resolved command — a match inside a comment or a statically dead construct does not count, and a command the assertion cannot statically resolve is reported unresolved, never satisfied. A no-op command (`true`, `:`, a bare `echo`, empty) is not satisfied either. Any miss exits non-zero listing `<name>@<tier>`; an empty `projectChecks` prints that none are declared and exits 0. It is copied into the project, so it carries ZERO third-party dependencies and runs on nothing but the project's own runtime. It cannot protect itself — that is deliberate: losing everything is loud (the job vanishes and the checker fails), and losing one job quietly is the failure this artifact closes. A project with NO scripting runtime omits this artifact and records `projectChecks: []` plus `projectChecksRationale` (§2.3) instead of acquiring a foreign dependency. |
| **CI workflow** | `.github/workflows/ci.yml` | Must mirror the gate tier. Authoritative pass/fail signal for pull requests. SHA-pin every action; docker-image actions by `@sha256:` digest (constitution §4.1). The workflow is itself a supply-chain artifact: it must be checked by a PINNED syntax auditor and a PINNED security auditor for the CI provider (recorded in the manifest's `ci.auditors`; for GitHub Actions the current researched anchors are actionlint + zizmor — see `patterns/ci-github-actions.md`). The managed block wraps ONLY managed jobs (and the managed steps inside them); the workflow HEADER — `name`, `on`, `permissions`, `concurrency`, and the `jobs:` key itself — is written once outside the block on first generation and preserved on re-run, and a comment above the block tells the project to add its own jobs BELOW it. Because the header is project-owned it is constrained as an ALLOWLIST rather than left alone: no top-level key outside that list (workflow-level `env` and `defaults` alter managed jobs' execution) and no duplicate job ids (they shadow a managed definition). Trigger requirements — the workflow must actually fire pre-merge — are in §3.3. |
| **Dependency-update config** | `.github/dependabot.yml` OR `renovate.json` | The upgrade path for a pin-everything harness — keeps pinned deps and SHA-pinned actions fresh. Covers the project's package ecosystem(s) + `github-actions`, and includes a release-age **cooldown** block (constitution §4.6). Pair it with the package manager's own minimum-release-age setting where the ecosystem has one — updater-side cooldown alone leaves the install path open. |
| **Dependency lockfile + frozen installs** | The ecosystem's lockfile (`package-lock.json`, `pnpm-lock.yaml`, `uv.lock`, `Gemfile.lock`, …) | Committed wherever the ecosystem supports one, generated with the pinned package-manager version. Every install in hooks/CI uses the FROZEN mode (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`, …) with NO fallback to fresh resolution — `npm ci \|\| npm install` silently re-resolves the tree (constitution §4.3/§4.6). |
| **Edit-tier hook** | Entry in `.claude/settings.json` (hook block) | Wires the `format` milestone into Claude Code's edit hook. Non-blocking, silent on success. Must also include a scope guard entry if the harness is generated for a pentest engagement. `.claude/settings.json` is managed at ENTRY level, never as a whole file: a re-run rewrites exactly the entries the manifest's `agentHardening.managedHooks[]` names and leaves every other key and entry untouched. The manifest is the AUTHORITATIVE record of that ownership — a `_claudeconf` marker inside an entry is human-readable convenience, because properties nested in a third party's settings schema are not a record this contract controls. The hook command parses its JSON payload with the PROJECT'S OWN runtime, invoked by an absolute project-rooted path (`$CLAUDE_PROJECT_DIR/node_modules/.bin/…`, `$CLAUDE_PROJECT_DIR/.venv/bin/python`): never an undeclared global helper such as `jq` (whose absence a trailing `\|\| true` would hide forever), never a bare global interpreter, and never an on-demand package runner (§3.3). **Bound, where the runtime IS the interpreter:** a language whose runtime the project already requires may have no project-rooted path for the interpreter itself — there is no `$CLAUDE_PROJECT_DIR/node_modules/.bin/node`. There the bare interpreter is ACCEPTED and the residual is recorded rather than pretended away: what the rule buys elsewhere (a missing helper failing loudly instead of being swallowed) is unavailable for the runtime that would report it, and a rule no conforming harness can satisfy trains generators to ignore the sentence. It is the same shape as the `.pre-commit-config.yaml` asymmetry note. Where a project-rooted path DOES exist — `.venv/bin/python`, `node_modules/.bin/<tool>` — it is required. Lockfiles are excluded from the edit hook's file glob. |
| **E2E scaffold + config** | e2e suite directory + framework config file (suite path fits the project's interface — `e2e/` for a UI, the integration-test dir for a CLI/service) | Must run unattended with no live external credentials. Framework + suite recorded in manifest. |
| **Pinned tool configs** | One config file per tool used by a milestone | e.g. `biome.json`, `vitest.config.ts`, `playwright.config.ts`, and the vendored SAST ruleset directory `.claudeconf/rules/` (pinned rule files committed into the repo — see `patterns/security.md`). Each config pins the tool version via the project lock file or an explicit version field. |
| **Repo hygiene** | `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), `.github/CODEOWNERS` | Baseline staples: consistent editor settings, normalized line endings (protects the determinism invariant), and code ownership. After generation, print a checklist to enable branch protection / required status checks (rulesets preferred). A generated ruleset JSON is OPTIONAL desired-state input that a human must review and import — its existence never implies protection is applied; the harness cannot change GitHub settings. |
| **Suppression approval ledger** | `.claudeconf/suppressions.json` + a check script wired into gate + CI — profile 6: the vendored `.claudeconf/bin/check-suppressions.mjs`; profile ≤5: a script such as `scripts/check-suppressions.mjs` | The human-approval path for silencing a control (constitution §4.7.2). The ledger records `{fingerprint, file, rule, rationale}` per approved suppression. The check diffs against the merge base and FAILS on any added or BROADENED suppression token, or any widened config-level exclusion (scanner exclude files, ignore configs), that lacks a ledger entry. Approval = a reviewed merge of the ledger change itself — the ledger sits on the protected surface, so a code-owner review of it IS the sign-off. It ALSO fails when a control disappears from a harness file (`control-removal`), where "disappears" means its IDENTITY is gone — the job or step name — not that a line's text changed. A command that is rewritten while its identity survives is a MODIFICATION, judged by the weakening rules; calling it a removal buries one real finding under dozens of "the file moved" entries, and noise is how a real entry gets waved through. Base selection is fixed where it matters: an explicit base override is REFUSED under CI with no allowlist and no escape flag, because an env-gated exemption is self-authorizing — any workflow edit can set it — and a shallow clone in authoritative CI is an ERROR, never an empty diff, since a clone that cannot see history otherwise passes by being unable to look. Finally, this check is a NOTIFIER whose pattern set is incomplete by construction, so its output must never read as a guarantee: a clean result states what it compared, never that no weakening occurred. |
| **Control-plane ownership** | Entries in `.github/CODEOWNERS` (GitHub implementation of §4.7.1) | Ownership entries for the DERIVED protected surface: CI workflows, hook-runner config, tool configs, manifests + lockfiles, scanner exclude/ignore files, provisioning scripts + checksums, the suppression ledger, and CODEOWNERS itself. CONFIGURED only — the post-generation checklist names the `enforced` bar: branch rules requiring code-owner approval, dismissing stale reviews, requiring approval of the latest push, and no bypass actors. Never claim `enforced` from the file's existence. |
| **Agent-hardening module** (`agentUse: true`) | `permissions.deny` entries + a `SessionStart` advisory hook in `.claude/settings.json` | Default-on runtime hardening: deny rules hide secret-bearing paths from the agent (defense-in-depth, NOT isolation — see `agent-hardening.md` for residual gaps), and the SessionStart hook injects a bounded, schema-validated advisory: declared profile + the runner-specific gate command ("declared", never "verified") and — at profile ≥5 — a second sentence naming `.claudeconf/delegation.md`, because a rule that lives only in a file nothing points at governs nothing. The advisory is a FIXED TEMPLATE of exactly two sentences at profile ≥5, not a place for free prose; the delegability rule itself lives in the artifact, never here. No Stop hook by default (see agent-hardening.md — experimental opt-in only). Both are managed at ENTRY level like the edit-tier hook: the SessionStart entry is listed in `agentHardening.managedHooks[]`, and the deny set is recorded verbatim as `agentHardening.denyPatterns`. A re-run reconciles against the RECORDED set — it removes those patterns, adds the current ones, and leaves project-owned deny entries alone. Patterns are `**/`-anchored so nested paths (`apps/api/.env`) are covered, and the module's note states plainly that deny rules govern Read/Edit only — **Bash is not covered** — and that `runtimeIsolation` is not configured. |
| **Delegability record** (`agentUse: true`, profile ≥5) | `.claudeconf/delegation.md` | The generated statement of constitution §4.7 rule 4 for THIS project: work may be delegated to a less capable agent or model only when one of the arbiters the file lists decides the result, and work whose mistakes could survive all of them may not be. Fully managed — rewritten wholesale on re-run, no sentinels — and DETERMINISTIC: the content is a function of the manifest, so a no-op regeneration is byte-identical (§3.5). Four required `##` sections, specified in §1.2: `## Rule`, `## Arbiters`, `## Never delegable`, and `## What this record is not`. The arbiter list is the machine-readable part and is matched BY VALUE rather than by prose — the backticked strings must be exactly the arbiters the manifest implies, no more and no less (§3.2) — so the record cannot rot into citing a gate that no longer exists. Wording is AGENT-AGNOSTIC: it names no vendor's orchestration primitives, because the rule outlives any particular agent runtime, and a harness that hardcodes today's primitives ages into instructions that mislead. The file is guidance an agent READS; nothing in the harness executes it, which keeps constitution §4.8 intact — verification is pointed at a harness, never wired into it. |
| **Manifest** | `.claudeconf/manifest.json` | See §2 for the complete schema. |
| **Vendored support scripts** (profile 6) | `.claudeconf/bin/` — the skill bundle's `scripts/harness/` directory copied VERBATIM — plus `harnessScripts: { "version" }` in the manifest | The scripts the harness runs — `check-suppressions`, `check-project-checks`, `assert-tool-versions`, `provision-tools`, `scan-tree` and their `lib/` — are VENDORED, never authored per project: hand-written gates were the field's largest source of checks that passed without checking. Node runs them in every stack (`runtimes.node`, §2.5). The directory is managed and must be excluded from formatters, linters and the edit hook, because the checker judges it against the bundle's catalog for the declared version: a missing, extra, edited or symlinked file fails, and so does a `.claudeconf/bin/` with no `harnessScripts` record. Upgrading the scripts means re-vendoring a newer bundle (`refresh`), never editing them in place. |
| **Provisioned-tool lock** (profile 6) | `.claudeconf/tools.lock.json` | Every binary the harness provisions by checksum, per platform (§2.5). The vendored `provision-tools.mjs` installs from it and `assert-tool-versions.mjs` asserts against it; nothing else repeats its versions. |
| **Runtime pin** (profile 6) | An exact version file for each `runtimes` entry — `.nvmrc` for Node | The version the CI workflow installs the runtime from (`node-version-file`) and `assert-tool-versions.mjs` asserts the executing runtime against. |

### 1.1 Scope guard (pentest context only)

When the harness is generated for a security or pentest engagement, the
`.claude/settings.json` edit hook must include a scope-guard wrapper that reads `.scope`
from the repository root and refuses to invoke any network-aware tool against a target
that falls outside the listed entries. See constitution §4.5 for the scope file format.

---

### 1.2 Delegability record format (profile ≥5)

`.claudeconf/delegation.md` carries four required `##` sections, each non-empty. Prose
inside them is free; the `## Arbiters` block is not — it is parsed.

1. **`## Rule`.** Both directions stated explicitly: delegation is permitted when an
   arbiter below decides the result, and forbidden when no arbiter would catch the
   mistake. A record that only licenses, or only forbids, is half the rule.
2. **`## Arbiters`.** One per line, exactly `` - `<exact string>` — <role> ``. The set of
   backticked strings is derived from the harness and nothing else:
   - the pinned gate invocation — the runner path the hook config declares plus the gate
     subcommand (`node_modules/.bin/lefthook run gate`), falling back to the bare
     `hookRunner.name` only where `runnerPinned` is false, since there is no path to cite;
   - every `projectChecks[].name`;
   - `ci.workflow`.
   Set equality is checked, so an arbiter that is removed from the manifest and left in
   the record FAILS, and so does one added to the record that the manifest does not name.
3. **`## Never delegable`.** The §4.7.1 control-plane surface, the suppression ledger,
   the manifest, and this file itself — never delegable, whatever any arbiter reports.
   These are the artifacts that decide what the arbiters check, so an arbiter's verdict
   on a change to them is circular.
4. **`## What this record is not`.** The checker verifies that these arbiters are NAMED
   consistently with the manifest. It does not establish that they are sufficient, and no
   artifact can establish that an agent obeyed the rule.

What the checker can establish about elements 1, 3, and 4 is that the sections exist and
are non-empty — it does not read the prose and does not judge whether the rule is stated
well. That bound is stated here so the check's evidence is not mistaken for more than it
is; only the arbiter list is verified by value.

The record states the rule; it does not enforce it. Treating it as a control would be
the same error §4.7 already names about `configured` versus `enforced`.

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
  "constitutionVersion": "4",
  "generator": "claudeconf-skill",
  "agentUse": true,
  "stacks": ["node"],
  "hookRunner": { "name": "lefthook", "version": "x.y.z", "runnerPinned": true },
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
  "e2e": { "framework": "playwright", "suite": "e2e/" },
  "projectChecks": [
    { "name": "schema-contract", "tiers": ["gate", "ci"], "run": "scripts/check-schema-contract" }
  ],
  "agentHardening": {
    "denyPatterns": [
      "Read(**/.env)",          "Edit(**/.env)",
      "Read(**/.env.local)",    "Edit(**/.env.local)",
      "Read(**/.env.*.local)",  "Edit(**/.env.*.local)",
      "Read(**/secrets/**)",    "Edit(**/secrets/**)",
      "Read(**/id_rsa*)",       "Edit(**/id_rsa*)",
      "Read(**/id_ed25519*)",   "Edit(**/id_ed25519*)",
      "Read(**/id_ecdsa*)",     "Edit(**/id_ecdsa*)",
      "Read(**/*.key)",         "Edit(**/*.key)"
    ],
    "managedHooks": [
      { "event": "PostToolUse", "matcher": "Edit|Write", "milestone": "format" },
      { "event": "SessionStart", "advisory": "session-start" }
    ]
  },
  "existing": { "preserved": [], "added": [], "note": "" }
}
```

Every milestone's `tiers` includes `gate` and `ci` — the Gate ≡ CI rule
(constitution §1).

`projectChecks` and `agentHardening` are profile-4 keys (§2.3): `projectChecks` is
always present (an empty array is an explicit declaration, not an omission) and
`agentHardening` is present whenever `agentUse` is true. `existing` is OPTIONAL and is
emitted only for an additive install over a project that already had checks — it is
shown here for shape.

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

### 2.5 Typed pins (profile 6)

At profile 6 a version is never COPIED into the manifest. Every place the manifest names a
version — a milestone entry and every `tools[]` element, each `ci.auditors[]` entry,
`hookRunner` — carries `pin: { "kind", "path", "key" }` INSTEAD of `version`: a reference
into the file that actually pins the tool. A copied literal was the field's single largest
source of drift: every dependency-update PR changed the lockfile and left the manifest, the
assertion script, the provisioning script and the hook config's `min_version` behind, so
every one failed the gate. The manifest also gains `runtimes`, a map of runtime name → pin
(`"node"` is required: the vendored support scripts run on it, §1).

| `kind` | `path` (default) | `key` | resolves to |
| --- | --- | --- | --- |
| `npm-lock` | `package-lock.json` | package name | `packages["node_modules/<key>"].version`; the sibling `package.json` must declare `<key>` at EXACTLY that version — a range fails |
| `uv-lock` | `uv.lock` | package name | the one `[[package]]` named `<key>`; two entries is ambiguous and fails |
| `tools-lock` | `.claudeconf/tools.lock.json` | tool name | `<key>.version` |
| `requirements` | (required) | package name | the one `<key>==<version>` line, which must carry `--hash` |
| `version-file` | (required, e.g. `.nvmrc`) | runtime name | the file's single exact version (one leading `v` allowed) |
| `runtime` | — | a `runtimes` key | that runtime's pin, resolved — for tools that version through the runtime (`npm-audit`, a repository script run by `node`); replaces `"n/a"` |

**One resolver, fail closed.** Pins are resolved by ONE function shipped in the bundle
(`harness/lib/pins.mjs`), imported by the checker and by every vendored script — there is no
second implementation to disagree with. A pin whose source is missing, unreadable,
malformed, ambiguous, outside the repository root (including through a symlink) or not an
exact version does not resolve, and a pin that does not resolve is a failure, never a
skipped comparison. The hook runner's `min_version` is a FLOOR, compared against the
resolved version; it is not a second copy of the pin.

**`.claudeconf/tools.lock.json`** pins every binary the harness provisions by checksum:

```json
{
  "trufflehog": {
    "version": "3.95.6",
    "released": "2026-07-31",
    "platforms": {
      "linux-x64": { "url": "https://…", "sha256": "…", "archive": "tar.gz", "member": "trufflehog" }
    }
  }
}
```

`platforms` keys are `<os>-<arch>` (`linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`); `archive` is one of `tar.gz`, `gz`, `zip`, `raw`; `member` is the path of
the executable inside the archive. Checksums are copied from the release's OWN upstream
checksum file — a digest computed from a download already trusted proves nothing.
Admission (constitution §4.6) is enforced mechanically, not by the `released` field:
`refresh` records `released` from upstream and refuses a release younger than the cooldown;
a tool CI runs from a digest-pinned image must have a `tools.lock.json` version EQUAL to the
image's (the image moves only through the updater, with its cooldown); and any change to a
`tools.lock.json` value is a `pin-change` the suppression gate blocks without a ledger entry.

### 2.3 Field rules

| Field | Rule |
| --- | --- |
| `constitutionVersion` | MUST match the machine-readable `constitution-version` marker at the top of `constitution.md`. Currently `"6"` (see constitution §6 for bump/migration semantics; a harness is judged at the highest profile it has claimed — the recorded value, an explicit target, or any value in the manifest's version-control history — and a rule newer than that is reported, never failed). A value no bundled profile recognises, or a missing field, is NOT a pass: an enforcing verification run fails on it (§3.6), so editing the field cannot green a harness. |
| `agentUse` | Boolean, default `true` (constitution §4.7). `false` requires an `agentUseRationale` string, may be chosen only at the generation human-review gate, and disables every agent-hardened claim. Changing the value later is a control-plane change (§4.7.3). |
| `generator` | Fixed string `"claudeconf-skill"`. |
| `stacks` | One or more stack identifiers detected by the skill. Non-empty array. |
| `hookRunner` | Object `{ "name", "version", "runnerPinned" }` (profile ≤5) or `{ "name", "pin", "runnerPinned" }` (profile 6, §2.5) — the runner (default `"lefthook"`, or the ecosystem-standard runner per constitution §5), its exact pinned version, and whether a pinned runner PATH is configured. A doctor cannot verify what it cannot identify; a bare name is a profile-2 form. |
| `hookRunner.runnerPinned` | Boolean, required at profile 4. `true` asserts that the managed hook config names a runner path the shim resolves before `PATH` (§1). `false` is permitted only for an ecosystem that cannot provide one and REQUIRES a `runnerPinnedRationale` string; the harness then reports the runner as unpinned rather than presenting the recorded version as a control. |
| `milestones` | MUST contain exactly the nine milestone keys listed in §2.2. No milestone may be absent. |
| `milestones[*].tool` | Exact tool name used. A single-tool entry has `tool` + `version`; a multi-stack entry has `tools[]` instead (§2.2.1) — never both, never a joined string. |
| `milestones[*].pin` | Profile 6: the typed pin reference (§2.5) that REPLACES `version`. An entry carrying both, or a profile-6 entry carrying only `version`, fails. Applies to every `tools[]` element. |
| `milestones[*].version` | Profile ≤5: exact pinned version string (or `"n/a"` for tools that version through the runtime, e.g. `npm-audit`, or a repository script the runtime executes, recorded as `node`). Floating ranges are forbidden, and so are composite strings — a version must not contain spaces or `+`. Applies to every `tools[]` element too. |
| `milestones[*].tiers` | Non-empty array. Each entry must be one of: `"edit"`, `"pre-commit"`, `"pre-push"`, `"gate"`, `"ci"`. Must cover at least the default tier(s) from constitution §2 (which include `gate` + `ci` for every milestone). |
| `ci.workflow` | Path to the CI workflow file, relative to the repository root. |
| `runtimes` | Profile 6, required: `{ "<runtime>": <pin> }` with at least `"node"` (§2.5). Each value is a typed pin, usually `version-file`; a `runtime` pin elsewhere refers to one of these keys. |
| `ci.auditors` | Non-empty array of `{ "tool", "version" }` (profile ≤5) or `{ "tool", "pin" }` (profile 6, §2.5) — the pinned SYNTAX auditor and SECURITY auditor for the CI provider's workflow format (constitution §4.1 applied to the workflow itself). Versions obey the same pin rules as milestones. Auditors are recorded here, never as a tenth milestone. |
| `milestones.sast.rules` | OPTIONAL provenance for the vendored SAST ruleset: `{ "source", "ref", "license" }`. Rules copied from a third-party pack MUST record the real source URL and an immutable commit `ref`; `"source": "hand-authored"` + `"ref": "n/a"` are valid ONLY for rules authored in this repository — never as an escape hatch for vendored content. |
| `e2e.suite` | Path to the e2e suite directory, relative to the repository root — or an array of paths for a multi-stack project (§2.2.1). |
| `projectChecks` | Array, REQUIRED at profile 4. It declares the checks the PROJECT owns, so a regeneration that drops one fails instead of passing silently. An empty array is valid and is an explicit statement that the project declares no checks — it is never the same as an absent key, and the harness reports "none declared", never "none detected". |
| `projectChecks[*].name` | Non-empty string matching `^[A-Za-z0-9._-]+$`. **Stated bound, found by the additive-install exemplar and not yet closed:** §1 permits declaring a CI check by STEP NAME, and a step name may legitimately contain spaces (`Prettier check`), which this pattern cannot express — so such a step is undeclarable, and declaring its JOB id instead binds the `run` substring to the job's FIRST command step rather than the intended one. The fix is to widen this pattern and keep the managed-name collision rule, which must move in the contract, the checker's `W12`, and both shipped assertion runtimes together; it was deferred rather than shipped as a three-way divergence. Until then a prose-named preserved step cannot be declared, and the harness must NOT resolve that by renaming it — it is project-owned. Also unique across the array, and NOT a managed job or step name (§2.4). It is the job name in the hook config and the job id or step name in the CI workflow. |
| `projectChecks[*].tiers` | Non-empty array; every entry one of `"pre-commit"`, `"pre-push"`, `"gate"`, `"ci"`. The check must resolve at each listed tier (§3.2). |
| `projectChecks[*].run` | REQUIRED, non-empty. An exact substring that must appear in an EXECUTED position of the resolved job's or step's command. Name-only protection is not protection: a job named `schema-contract` running `exit 0`, `printf ok`, or `<tool> --version` satisfies the name and checks nothing. Binding the command means the manifest churns when a command genuinely changes — that is a control-plane change and deserves the review, and it is cheaper than the false PASS it prevents. The resolved command must also be SIGNAL-BEARING (§3.3): a trailing `|| true`, or a `continue-on-error: true` on the matched step or its job, leaves the check present, running, and incapable of turning anything red — which is the same signal as having deleted it. |
| `projectChecksRationale` | String, required IFF the Project-check assertion artifact (§1) is absent — permitted only when the project has no scripting runtime at all, and it must say which runtime was missing. `projectChecks` must then be `[]`. Never a way to opt out of the assertion in a project that could run it. |
| `agentHardening` | Object, required IFF `agentUse` is true. Records the agent-hardening module's OWNED surface so a re-run can reconcile it: `denyPatterns` plus `managedHooks[]`. |
| `agentHardening.denyPatterns` | Non-empty array of EXACT permission-rule strings — the set the harness owns in `.claude/settings.json` `permissions.deny`. Exact strings, not globs to be interpreted by the harness: a re-run removes exactly these, adds the current set, and leaves every other deny entry as project-owned. The live deny list is therefore a superset of this array (§3.2). |
| `agentHardening.managedHooks` | Array; the AUTHORITATIVE record of which `.claude/settings.json` hook ENTRIES the harness owns. Each element is `{ "event", "matcher"?, "milestone" \| "advisory" }`: `event` is the settings hook event (e.g. `"PostToolUse"`, `"SessionStart"`), `matcher` is present exactly when that event's entries carry one, and `milestone`/`advisory` records what the entry is for. The `(event, matcher)` pair is unique across the array and must resolve to exactly one entry in the settings file; the managed set and the set of entries carrying a `_claudeconf` marker must be equal (§3.2). |
| `existing` | OPTIONAL object `{ "preserved", "added", "note" }`, emitted only for an additive install over a project that already had checks. `preserved` and `added` are arrays of strings naming the checks/tools left alone and the ones the harness added (a workflow job may be named `<path>#<job>`); `note` is a short human sentence recording what was preserved and why. It is a record, not a control: nothing in it exempts an artifact from §1 or a check from §3. Two consequences of an additive install are INTENDED and must not be "fixed": the project's preserved check and the harness's own pinned one both run, so a milestone is covered TWICE — adopting the project's job into the managed set instead is precisely what the ownership split forbids by default (§2.4); and a supply-chain INFO raised against a PRESERVED job can never be resolved by a harness forbidden to edit it. Such an INFO may be ACKNOWLEDGED here — recorded in `note` against the job it concerns — and an acknowledged INFO is reported as acknowledged rather than as an open finding. A permanent finding with no resolution path is not a warning, it is training in ignoring warnings; acknowledgement keeps it visible while saying who owns it. |

### 2.4 Managed job and step names

Managed names are a CLOSED, NORMATIVE set. They are what a regeneration rewrites, what
wiring is located by, and what a project-owned name must never collide with — so they
cannot be left to convention.

A managed hook job is named for its milestone, optionally with one approved suffix:

| Milestone | Managed job name(s) |
| --- | --- |
| format | `format`, `format-check` |
| lint | `lint` |
| typecheck | `typecheck` |
| unit | `unit`, `unit-changed`, `unit-full`, `unit-coverage` |
| e2e | `e2e` |
| SAST | `sast` |
| secret-scan | `secret-scan` |
| dependency-audit | `dependency-audit` |
| build | `build` |

Plus four harness-infrastructure jobs that belong to no milestone: `tool-versions`,
`workflow-audit`, `suppressions`, `project-checks`.

Plus `commitlint`, which the generator emits for the commit-message hook.

For a MULTI-STACK project (§2.2.1) a managed name may carry a per-stack suffix —
`lint-node`, `lint-python`, `unit-node` — because one milestone genuinely has one job
per stack there. The milestone name remains the part before the first `-`, so the set
stays closed and locatable; a suffix is not licence to invent a name outside it.

Managed CI STEP names use the SAME tokens: a managed CI step name LEADS with any name in
its milestone's row above — `format-check …` and `format (check) …` are both managed,
because both lead with a name the set contains. Managed CI JOB IDS are NOT a name set at all: a
managed CI job GROUPS several managed steps, so it is located by POSITION — being inside
the managed region — and its id is free. Five harnesses built from this contract use four
different conventions (`ci`, `claudeconf`, `harness`, `security`), which is the evidence
that no closed set was ever discovered here: one was asserted from a single example.
A name set is required only where a NAME is load-bearing — hook job names, because the
runner merges same-named jobs across layers, and CI step leading tokens, because that is
how a step is located. A job id is neither. Project-owned job ids are already constrained
where it matters: §3.3 rejects duplicate ids, because a later definition shadows a managed
one. A step MAY append a parenthetical for humans
(`unit-coverage (vitest)`); the token must be the FIRST whitespace-delimited word of the
step name, so a step is located by token and never by prose.

The set is closed over hook job NAMES in both directions. Over the leading token of CI
step names it is closed in ONE direction only, and the difference matters: no
project-owned step may lead with a name in the set — that half is load-bearing, because
it is how a managed step is located — but a managed step may legitimately lead with a
name OUTSIDE it. Every shipped harness has managed steps like `install (frozen)`,
`provision tools` and `zizmor (workflow security audit)` that belong to no milestone.
Managed steps that DO carry a milestone lead with that milestone's token; everything else
in a managed region is managed by POSITION, and the auditors are located by TOOL IDENTITY
inside the region rather than by name — §2.4 has no auditor token, so a rule demanding
one is unsatisfiable. No name inside it may be used by a project-owned hook job or the leading token
of a project-owned CI step — including one PRESERVED from a runner or a workflow the
project already had. CI job IDS are not one of those spaces (see above): a managed CI
job is located by position, and a project-owned id is constrained only by §3.3's
rejection of duplicates. A preserved check the
human-review gate does not adopt as a generated milestone stays project-owned and is
RENAMED away from the set, with its `projectChecks` entry using the new name; only a
check positively adopted at that gate moves into the managed file or the managed region.
Existing jobs and steps are project-owned by DEFAULT — a matching name is not evidence
of ownership, since a project's own `lint`, `build`, `unit`, or `e2e` job is entirely
plausible, and absorbing it into the managed set is the very failure this split closes.

Neither collision is cosmetic, and the two have different mechanics but the same
outcome. In the hook config the runner MERGES same-named jobs across `extends`, so a
project-layer job named for a managed one contributes its fields to the managed job and
can disable it while the merged command still reads correctly (§3.3). In the workflow
there is no merge — instead a project-owned step whose name LEADS with a managed token,
sitting OUTSIDE the managed region, can ANSWER a check that is looking for the managed
step, reporting a control as present while the real one is missing, weakened, or a
no-op. Both halves of the fix are required: §3.3 scopes every managed-step and
managed-job-id lookup to WITHIN the managed region so a stray token cannot answer for a
managed one, and this section denies the name so the ambiguity does not arise in the
first place.

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
- [ ] `constitutionVersion` equals the `constitution-version` marker in
  `constitution.md` (`"4"`), and `hookRunner` records `name`, a pinned `version`, and
  `runnerPinned` — with a `runnerPinnedRationale` whenever `runnerPinned` is `false`.
- [ ] `projectChecks` is PRESENT (an empty array is an explicit declaration; an absent
  key is a defect), and every entry has a unique `name` matching `^[A-Za-z0-9._-]+$`
  that is not a managed name (§2.4), a non-empty `tiers` subset of the four tiers, and
  a non-empty `run`.
- [ ] With `agentUse: true`: `agentHardening.denyPatterns` is a non-empty array of exact
  strings and `agentHardening.managedHooks[]` names every settings entry the harness
  owns, each `(event, matcher)` pair unique.
- [ ] If `existing` is present: `preserved` and `added` are arrays of strings and `note`
  is a non-empty string. It records what an additive install left alone and what it
  added — it never exempts an artifact from §1 or a box from §3, so a check does not
  soften because a path is listed there.

### 3.2 Artifact existence

- [ ] Git-hook config exists in its SPLIT form: `.claudeconf/lefthook.yml` (the managed
  file, holding every generated hook) exists, and the project-owned root `lefthook.yml`
  contains exactly one managed block whose `extends` list includes
  `.claudeconf/lefthook.yml`. (`.pre-commit-config.yaml` instead, only under
  constitution §5 — single file, managed-region model.)
- [ ] Where a runner setting must be written in TWO layers (§1 — because the runner
  merges some settings and not others), the copies must AGREE, and that equality is
  itself checked. Two records of one value drift silently in both directions, and the
  harness would then be pinning one runner and running another with every check that
  reads either copy alone reporting fine.
- [ ] A pinned runner path that is ABSENT because the project's dependencies are not
  installed is MACHINE STATE, not a broken pin — the same rule this section already
  applies to hooks not being installed. Distinguish the two: install root absent is
  UNVERIFIED; install root present with the binary missing is a failure. A shipped
  exemplar is checked as shipped and cannot have its dependencies installed, so
  conflating these makes a correct harness unpinnable and pushes it toward recording
  `runnerPinned: false` — a FALSE record, and the worst thing an exemplar can teach.
- [ ] A config file consumed by a THIRD-PARTY SERVICE is verified by that service, not
  by us. Our check establishes that the harness asked for the right thing; only the
  service establishes that it accepted the file, and a service that rejects a config
  usually rejects the WHOLE file rather than the offending key. Verified the hard way:
  this repository carried `semver-major-days` under the `github-actions` ecosystem, which
  Dependabot does not support — our check reported the cooldown present and PASSED, while
  Dependabot rejected the entire config and ran no updates at all. Treat the service's own
  status check as part of the merge bar, and never read a green harness verdict as
  evidence the service accepted anything.
- [ ] Runner pinning is verified BY RESOLUTION, never by reading the setting back. A
  textual check on a setting the runner ignores reports a control that does not exist —
  observed: with the path pinned exactly as this contract first prescribed, the
  config-reading checks passed while every hook ran a global binary, and only the check
  that inspected the installed shim caught it. So the verifier resolves the runner the
  way the shim does and probes THAT executable (§3.4), and a mismatch between the
  pinned path and the resolved one is a failure whatever the config says.
- [ ] With the default runner and `hookRunner.runnerPinned: true`, the harness sets all
  three runner-pinning fields, each in the layer the runner reads it from (§1):
  `lefthook:` pointing at a runner path
  that EXISTS, `assert_lefthook_installed: true`, and `min_version` EQUAL to the
  manifest's `hookRunner.version`. Two carve-outs, and only two, both granted by §1/§2.3
  rather than invented here. `runnerPinned: false` — permitted only for an ecosystem
  that cannot provide a pinned runner path, and only with a `runnerPinnedRationale` —
  drops the path field alone; the abort-on-missing-runner and minimum-version fields are
  still required, because neither depends on a pinned path. An ecosystem-standard runner
  chosen under constitution §5 is checked against ITS equivalents: the field names above
  are lefthook's vocabulary, and what is required of any runner is the OUTCOME — a
  pinned executable where the runner can express one, a missing runner that aborts
  rather than passes, and a recorded minimum version. Where a runner cannot express one
  of those, the gap is recorded, and the harness never presents it as a control it does
  not have.
- [ ] The installed hook shim contains the pinned-runner branch — i.e. the value
  configured above actually reached `.git/hooks/*` (or the configured `core.hooksPath`)
  at `install` time. A shim without it resolves the runner from `PATH`, so the harness
  is `configured` but not pinned. Skipped, not failed, when no runner path is pinned
  (`runnerPinned: false`). Hooks not being installed on THIS machine is local state, not
  harness content: report it, never fail on it (§3.6).
- [ ] CI workflow exists: `.github/workflows/ci.yml`.
- [ ] The project-check assertion script exists at the path §1 names, is written in a
  runtime one of the manifest's `stacks[]` already requires, and is wired BOTH as a
  `project-checks` job in the managed gate AND as a `project-checks` step in the managed
  CI workflow — present even when `projectChecks` is empty. (Absent only with
  `projectChecks: []` plus `projectChecksRationale`.)
- [ ] Every `projectChecks` entry resolves at EVERY tier it lists: a job of that name in
  the merged hook config for `pre-commit`/`pre-push`/`gate`; a job id or step name in
  the CI workflow for `ci`; its `run` substring present in an executed position of the
  resolved command; the command not a no-op; and, for a CI entry, the job actually
  reachable (§3.3).
- [ ] `.claude/settings.json` contains an edit-tier hook entry for the `format`
  milestone.
- [ ] If pentest context: `.claude/settings.json` hook also contains a scope-guard
  wrapper; `.scope` file exists at the repository root.
- [ ] E2E scaffold exists: the suite directory recorded in `manifest.e2e.suite`
  is non-empty and contains at least one test file.
- [ ] Pinned tool configs exist for every tool referenced in the manifest — in every
  directory the harness runs the tool from (a hook job's `root:`, a CI `working-directory`, a
  `cd` or a runner's directory flag such as `npm --prefix app`), or in a directory above it.
- [ ] Dependency-update config exists (`.github/dependabot.yml` or `renovate.json`)
  and contains a cooldown block (constitution §4.6). Profile 6: no updater key the
  service does not support — Dependabot accepts `semver-*-days` only for ecosystems that
  version by SemVer, rejects them under `github-actions`, `docker`, `terraform` and the
  other default-days-only ecosystems, and rejects the WHOLE file when it sees one (checker
  A3).
- [ ] The ecosystem lockfile is committed (where the ecosystem supports one), and
  every install command in hooks/CI uses the frozen mode with no fresh-resolution
  fallback.
- [ ] Repo-hygiene staples exist: `.editorconfig`, `.gitattributes`,
  `.github/CODEOWNERS`.
- [ ] The whole-tree scanner exclude file exists (e.g.
  `.claudeconf/trufflehog-exclude.txt`) and covers VCS metadata + vendored trees.
- [ ] Profile 6: the gate runs every whole-tree scanner through the vendored
  `scan-tree.mjs -- <scanner> … {tree}`, which scans the INDEX — exactly the content the
  next commit carries and, on a clean tree, exactly what CI checks out — never the working
  directory, whose ignored and untracked files CI never sees. The checker holds the gate's
  secret scan to this (A17).
- [ ] Profile 6: `.claudeconf/bin/` is the bundle's `scripts/harness/` directory, unmodified,
  and the manifest records its `harnessScripts.version` (checker A17). Every hook job and CI
  step that runs a bundle script runs THAT copy, at exactly `.claudeconf/bin/<script>.mjs`: a
  same-named script anywhere else — another directory, another extension, a nested
  `.claudeconf/bin/` — is a copy nothing verifies, and A17 fails it.
- [ ] `.claudeconf/suppressions.json` exists (empty array is valid) and its check
  script is wired into the gate AND CI (§4.7.2).
- [ ] CODEOWNERS carries ownership entries for the full derived control plane —
  including the suppression ledger and CODEOWNERS itself (§4.7.1).
- [ ] With `agentUse: true`: `.claude/settings.json` contains the
  `permissions.deny` module and the SessionStart advisory hook; the manifest has
  no Stop hook wired by default.

- [ ] With `agentUse: true` at profile ≥5: `.claudeconf/delegation.md` exists and carries
  all four §1.2 sections, each non-empty. Section presence is what is verified; the prose
  inside them is not read, and the check's evidence says so rather than implying the rule
  was judged. A missing or unreadable file is reported as such, never inferred from the
  manifest alone.
- [ ] The `## Arbiters` set equals the set the harness implies — the pinned gate
  invocation, every `projectChecks[].name`, and `ci.workflow` — compared as exact
  backticked strings in BOTH directions. A manifest arbiter missing from the record and a
  record arbiter absent from the manifest are both failures: the first understates what
  decides, the second points agents at a verifier that may no longer run.
- [ ] The SessionStart advisory matches the profile-≥5 fixed template — the declared
  profile and gate command, then the pointer at `.claudeconf/delegation.md`.
- [ ] Entry-level ownership of `.claude/settings.json` holds in BOTH directions: every
  entry named by `agentHardening.managedHooks[]` exists and carries the `_claudeconf`
  marker, and every entry carrying that marker is named by `managedHooks[]`. The two
  sets are equal, and no other key or entry in the file is rewritten by a re-run.
- [ ] `permissions.deny` CONTAINS every string in `agentHardening.denyPatterns`; entries
  beyond that recorded set are project-owned and survive a re-run untouched.
- [ ] The post-generation output states `configured` vs `enforced` separately and
  prints the enforcement checklist (code-owner approval, dismiss stale, latest
  push, no bypass) without claiming any of it is active. It also NAMES the required
  status check to enable (§3.3), and states that any change to the runner-pinning
  fields (§1) requires re-running the runner's `install`, because those values are
  baked into the installed shims and a stale shim silently keeps the old resolution.

### 3.3 Milestone wiring

- [ ] Profile 6: every CI step answering a milestone or a declared project check — and
  the job holding it — runs on EVERY pull request: no `if:` beyond `always()` /
  `success()`, and no repository secret (`GITHUB_TOKEN` excepted). Bot and fork runs
  receive no repository secrets, and a skipped required check reports green. Work that
  genuinely needs a credential belongs in an ANCILLARY step, never in a required check:
  provisioning the secret as a Dependabot secret too would still leave fork runs without it,
  and the checker cannot see that store. Actor identity may select ancillary behaviour,
  never whether a required check runs (checker W21).
- [ ] Every milestone listed in `milestones` is wired into every tier in its
  `tiers` array — i.e. the hook config has a job for each `pre-commit` / `pre-push` /
  `gate` milestone, and the CI workflow has a step for each `ci` milestone. Hook wiring
  is checked against the MERGED configuration the runner actually executes
  (`lefthook dump -f json`), never against the root file alone. An `extends` target that
  cannot be resolved makes the wiring UNVERIFIED — naming the unresolved path — never a
  pass on a partial configuration.
- [ ] EVERY lookup for a managed CI job or step — wiring, tool equivalence, auditors,
  the infrastructure steps, all of them — is scoped to WITHIN the managed region, and
  matches the §2.4 token, never prose. A job id or step outside the region NEVER
  satisfies a managed requirement, whatever it is named. Without this scoping the region
  model collapses: a project-owned step leading with a managed token, sitting outside
  the block where regeneration cannot reach it, would report a control as present while
  the managed step is missing or a no-op — the same green-signal-for-an-absent-control
  shape the ownership split exists to close. §2.4 additionally denies that name to
  project-owned steps and job ids, so the two rules close the hole from both sides.
- [ ] Managed-job IDENTITY: for every job declared in the managed hook config, its
  definition in the MERGED configuration is FIELD-IDENTICAL to that declaration. Any
  divergence at all fails, naming the field and — where determinable — the file that
  contributed it. This is the check that makes the ownership split sound, and it is
  stated as identity rather than as a list of dangerous fields so a future runner
  release cannot outrun it. The failure it closes is verified, not hypothetical: because
  the runner merges same-named jobs across `extends`, a project-layer job named for a
  managed one carrying nothing but `skip: true` disables the managed check — the run
  prints the job as skipped by condition and exits 0 GREEN, while the merged
  configuration still shows the correct command, so a wiring check that reads only the
  merged dump passes.
- [ ] RAW-LAYER ownership: the project layer — the root hook config and any non-managed
  `extends` target — declares NO job whose name is in the managed set (§2.4), and no
  execution control — `skip` or `only` — at HOOK scope, nor at JOB scope on a job whose
  name is managed or that a `projectChecks` entry declares. Job scope is not the lesser
  case there: a job-scope `skip` disables that one check while the run still reports
  success, which is the whole F13 shape aimed at a single job. On a project-owned job
  that nothing declares, `skip`/`only` are the project's own business and are NOT a
  finding — the harness constrains what it is asked to guarantee, not every line a
  project writes.
  `exclude` is deliberately NOT in that list: it selects which FILES a job runs on, not
  whether the job runs, and excluding lockfiles from a secret scan is ordinary. A
  project-layer `exclude` applied to a MANAGED job is caught where it belongs — by
  managed-job field identity above, which fails on any divergence and names the field.
  On a job the harness GUARANTEES but does not manage — one a `projectChecks` entry
  declares — a file filter is read the same way a `skip` list is, because at the limit
  it stops being a filter and becomes a bypass: verified against the pinned runner, a
  job whose command exits 7 still exits 0 under `exclude: ["*"]` with root-level staged
  files, and under `["[a-z]*"]`, `["?*"]` or `["*.*"]`, each reporting `no files for
  inspection` while the declared command still sits correctly in the merged dump.
  Note what that list shows: `["**/*"]` does NOT empty the set, and `["*"]` empties it
  only when every staged path is at the root. Whether a pattern is a bypass is a
  property of the FILE SET at run time, not of the pattern — which is why this must be
  an allowlist and why per-pattern reasoning cannot be made to work. Such a
  filter counts as narrowing only when it demonstrably leaves files, and is UNRESOLVED
  otherwise. On a project-owned job nothing declares, it remains the project's own
  business.
  A LIST-valued `skip`/`only` is not automatically a narrowing. `skip: [{ref: "*"}]` and
  `skip: [{run: "true"}]` match in EVERY context and disable the job unconditionally —
  verified against the pinned runner — which is `skip: true` with one extra line. So the
  list form is read as an ALLOWLIST: it counts as live only when every element is a
  condition that demonstrably narrows, and anything else is UNRESOLVED and never
  satisfies a wiring or `projectChecks` requirement.
  `only` INVERTS that reading and needs its own rule: it names the only contexts in
  which the job runs, so a literal-ref `only` leaves the check inert everywhere else.
  On a blocking tier that includes the feature branches where the gate is run before a
  PR — the case the gate exists for — so on a guaranteed job an `only` that does not
  demonstrably include the pre-merge context is UNRESOLVED. Runner-verified: a gate job
  with `only: [{ref: main}]` whose command exits 7 makes lefthook exit 1 on `main` and
  exit 0 on a feature branch. Accept the shapes this contract
  wants to allow and refuse the rest; the reverse — denying the shapes known to be
  dangerous — is the mistake §2.4 and the managed-job identity rule already avoid. This is checked on the raw
  files, because by construction the merge hides exactly this. A `lefthook-local.yml`,
  if present, is REPORTED: it is VCS-ignored and overrides every other layer, which
  makes it a local bypass equivalent to `--no-verify`, not a merge-boundary control.
- [ ] The gate group carries the FULL battery (Gate ≡ CI, constitution §1): format
  check, lint, typecheck, unit + coverage, e2e, SAST, whole-tree secret scan,
  dependency audit, build — the same set the CI workflow runs — plus the harness
  infrastructure jobs `tool-versions`, `workflow-audit`, and `suppressions` (§2.4). The
  `project-checks` job is required on the same terms as the artifact it runs (§1/§3.2):
  present whenever the project-check assertion exists, and absent only in the one case
  that artifact is — a project with no scripting runtime, recording `projectChecks: []`
  plus `projectChecksRationale`. Wired but not runnable, or runnable but not wired, are
  both failures; only the recorded no-runtime case omits the pair.
- [ ] Gate ≡ CI is asserted at the TOOL, not the name: for every milestone carrying both
  `gate` and `ci`, the tool token extracted from the gate job's command and from the
  MANAGED CI step's command — located inside the managed region per the box above — must
  both be the tool the manifest records for that milestone. For a multi-stack `tools[]`
  entry, gate and CI must reference the SAME subset — not merely some entry each. A
  no-op (`true`, `:`, a bare `echo`, an empty command) FAILS. Invoking the right tool is
  not sufficient either: a command whose only operation is a version or help probe
  demonstrates nothing, so it FAILS outright rather than being deferred to the run mode
  — a demonstrably inert control must be reported as broken even by an advisory run. A
  PASS requires the command to name what it OPERATES ON — either a target (a path,
  glob, scope token, or config flag) or a TASK whose definition carries the operation
  (`npm test`, `npm run <script>`, `python -m <module>`, `cargo test`, `make <target>`).
  A task-naming invocation is not a probe: the operation lives in the task, so where
  that definition is resolvable it must be resolved and judged (a script body of `true`
  FAILs exactly as a bare `true` would), and where it is not resolvable the invocation
  still satisfies this rule rather than being punished for indirection.
  A STATED BOUND, so it is a known property rather than a hidden hole: where the task
  body lives outside the command — a Makefile target, a project shell script — a
  verifier that cannot read it does not judge it, so a swallow written INSIDE that body
  is not caught. `npm run <script>` is resolved inline and IS judged. This bound is
  acceptable only because of who owns what: a `projectChecks` body is the project's own
  code, which the project may weaken at any time, and the control for that is the
  suppression ledger plus code-owner review of the diff (§4.7) — not this assertion,
  whose job is to catch a check being DROPPED or DISCONNECTED. It would not be
  acceptable for a MANAGED job, and managed jobs never use that indirection because the
  generator writes their commands. Only a command
  that names neither a target, nor a task, nor a PINNED CONFIG the tool reads by
  convention — a config-driven formatter or linter takes no argument legitimately, and
  the pinned config is its operational scope — or whose sole operation is a version or
  help probe, is UNVERIFIED, which an enforcing run treats as a failure (§3.6). Both commands are printed per
  milestone — pass or not — so a human sees the scope drift a machine cannot adjudicate.
- [ ] The `format` milestone is wired into the `.claude/settings.json` edit hook
  (file-scoped autofix on the edited file — never a whole-project reformat) and is
  advisory at every tier: NOT in the git-hook config's blocking pre-commit/pre-push
  groups, and non-blocking in gate/CI check mode (`|| true` /
  `continue-on-error: true`).
- [ ] The `e2e` milestone is present in the CI workflow and in the gate tier of
  the git-hook config (or a separate gate script).
- [ ] The CI workflow actually FIRES, and fires PRE-MERGE. Its triggers must cover a
  pull request against the DEFAULT branch — no `branches` / `branches-ignore` list that
  excludes it — with event types that include the pre-merge set (`opened` and
  `synchronize`, whether by default or named explicitly); and a push to the default
  branch. NEITHER of those authoritative triggers carries `paths` or `paths-ignore`. A
  narrowed trigger is the quietest possible failure: a workflow that never runs reports
  no status at all, while every step-level check inside it still "passes". The workflow
  header is project-owned by design (§1), so a regeneration cannot restore a deleted or
  narrowed trigger — this check is the only place it is catchable. For the same reason
  the post-generation checklist names the required status check BY NAME: naming it is
  `configured`; only the platform can make it `enforced`.
- [ ] The CI workflow's top-level keys are limited to the allowlist `name`, `on`,
  `permissions`, `concurrency`, `jobs` — project-owned does not mean unconstrained.
  Workflow-level `env` and `defaults` are rejected because they alter the execution of
  managed jobs from outside the managed block, and duplicate job ids are rejected
  because a later definition shadows a managed one. A project that genuinely needs
  workflow-level `env` is a case for a managed reusable workflow, not for weakening this
  rule.
- [ ] The CI managed region is PLACED correctly, not merely present: it does NOT begin
  at line 1 of the workflow, every header key (`name`, `on`, `permissions`,
  `concurrency`, and the `jobs:` key itself) sits OUTSIDE it, and it contains only
  managed jobs and their steps. A region that spans the whole file has no "outside":
  every project-owned job falls inside it and the next regeneration deletes them —
  precisely the loss this profile exists to prevent. The header allowlist above does not
  catch this on its own, because a whole-file region satisfies it perfectly; placement
  has to be checked directly.
- [ ] Reachability — required wherever a check demands that a CI job or step actually
  RUN, including every `projectChecks` resolution (§3.2) — means all of: the matched
  STEP's own `if` is evaluated, not only its job's; every `needs:` target exists and is
  itself reachable, followed TRANSITIVELY rather than one level deep; a
  `strategy.matrix` that expands to zero combinations is REJECTED, because a matrix job
  that schedules nothing runs nothing; and any nontrivial condition is UNVERIFIED unless
  it can be shown true for the authoritative pull-request event. Existence is not
  reachability: in the signal it produces, a step that is present and never runs is
  indistinguishable from one that was deleted.
- [ ] Signal-bearing — required of every check a tier is meant to ENFORCE, on the same
  terms as reachability and for the same reason: a check that runs to completion but
  cannot report failure produces exactly the signal of a check that was deleted. State
  it as a POSITIVE obligation: a command is signal-bearing only when there is a
  demonstrable path by which the invoked tool's non-zero exit becomes the command's
  non-zero exit. The verifier must SHOW propagation, never hunt for known ways of
  discarding it — a list of swallow shapes is always one shape short. `|| true`, a
  pipeline into another command without `pipefail`, `set +e`, `|| true || false`, and
  the tool used as an `if`/`while` CONDITION all discard the status, and each of those
  was found only after a list that did not contain it had been written. Where
  propagation cannot be shown the verdict is UNRESOLVED, which an enforcing run fails
  (§3.6). On the CI side `continue-on-error: true` on the matched STEP or on its JOB
  discards it too; an expression-valued `continue-on-error` is UNRESOLVED.
  Unresolvability is a FLOOR, never a ceiling. Compute the strongest verdict the text
  DEMONSTRATES first and fall back to UNRESOLVED only when nothing stronger is
  demonstrable — a command that demonstrably discards its status does not become
  unresolved merely because it also contains a construct the verifier cannot read.
  Otherwise one `$( )` placed beside a swallow launders a FAIL, and the safety valve
  becomes the bypass. One profile qualifier applies, stated here so it is not invented
  in code: an UNRESOLVED signal-bearing verdict is UNKNOWN at profile ≥4 (which an
  enforcing run fails) and INFO at ≤3, so a profile-3 harness is not retroactively
  failed over a command shape this rule never asked it to avoid. A DEMONSTRATED swallow
  FAILs at every profile. EXEMPT is any milestone the constitution records
  as ADVISORY in its §2 mode column — today `format` and `dependency-audit`. State that
  exemption as a property of the recorded mode, never as a list of milestone names: an
  enumerated list goes stale the moment a mode changes, and the harness would then fail
  a milestone its own constitution mandates be advisory. For `format` the swallow is
  additionally REQUIRED by the bullet above, so its ABSENCE fails there rather than
  here. The rule binds managed jobs and steps and every `projectChecks` resolution
  alike (§3.2): the ownership split changes who writes a check, never what its green
  tick is allowed to mean. It applies at every tier the constitution's §1 mode column
  records as BLOCKING — pre-commit, pre-push, gate, CI — and not at `edit`, which that
  same column records advisory; read the tier exemption from the recorded mode, exactly
  as the milestone exemption is read.
- [ ] Signal-bearing is judged on the statement that INVOKES the tool, not merely on
  the last statement of a multi-line command, and demonstrating propagation from it
  requires accounting for all four of: ERREXIT state — `set -e` / `set +e` as the
  command itself sets them, and the provider's default, where GitHub Actions runs a
  `run:` under `bash -e` but applies `pipefail` only when the step declares
  `shell: bash`; POSITION — a statement that is not last, with no errexit in effect,
  hands its status to whatever follows; PIPELINES — without `pipefail` only the last
  element's status survives, so a tool piped into anything else is swallowed; and
  CONSUMPTION — a status read by a conditional, a `!`, or a subshell test never becomes
  the command's own. A step declaring a shell other than `bash` is UNRESOLVED rather
  than assumed either way — `shell: bash` is not "non-default" in the sense that
  matters here: it is fully known, and known to add `pipefail`. Getting this wrong in the lenient direction hides a broken check;
  getting it wrong in the strict direction fails a working harness and sends its owner
  looking for a suppression, so both directions need cases.
- [ ] The verifier's reading of a command is CONSERVATIVE — which means it must not
  GUESS, not that it must refuse whatever looks complex. What it can read structurally
  it reads: a here-document body is DATA rather than statements, and nested groups are
  parsed. What it cannot read it collapses to an OPAQUE token and carries as unknown,
  so the surrounding structure stays analysable and the unreadable part does not spread
  to swallow the whole command. Only where the verdict actually RESTS on what is inside
  an opaque region is it UNRESOLVED — and never a guess at which lines execute. This
  composes with the floor rule above: a verdict the text still demonstrates outside the
  opaque region stands, which is what stops an unreadable fragment from being usable as
  a laundering token. An arbiter that invents an answer is worse than one that admits it
  cannot tell, because in the report the invented answer is indistinguishable from a
  verified one.
- [ ] Supply-chain hardening of the CI workflow: every `uses:` is pinned to a full
  40-character commit SHA (not a tag like `@v4`); docker-image actions are pinned by
  an immutable `@sha256:` DIGEST — an exact tag is mutable and not acceptable; a
  trailing comment records the human-readable version. The workflow sets a
  least-privilege top-level `permissions:` block (`contents: read`, escalated
  per-job only as needed). (Constitution §4.1.) Those requirements are ENFORCED inside
  the managed regions. The same exposures OUTSIDE a managed region — in jobs the
  project wrote itself — are REPORTED with the fix rather than failed, so an additive
  install over hand-written jobs is not blocked by pre-existing debt while the exposure
  stops being invisible. The exception is a job a `projectChecks` entry declares: the
  project opted that job into the harness, so it is held to the managed bar and fails.
- [ ] Every `ci.auditors` entry is wired: the pinned workflow syntax auditor and
  security auditor run against the CI workflow in CI itself AND in the local gate
  (malformed YAML must be caught before the workflow is the thing that can't run).
- [ ] No hook job, gate job, or managed CI `run:` step FETCHES tooling at execution
  time: no on-demand package runners (`pipx run`, `uvx`, `npx -y`), no `pip install`
  without `--require-hashes`, no `curl … | sh` (constitution §4.2/§4.3).
- [ ] Beyond that, NO hook job, gate job, managed CI step, or `.claude/settings.json`
  hook command invokes a tool through an on-demand package runner (`npx`, `npm exec`) in
  ANY form. A no-install flag is not an exemption: it only declines to install NOW, and
  a previously cached foreign package of the same bin name still satisfies it —
  verified, with a cached unrelated package answering the pinned tool's name.
  Project-local tools are invoked by their pinned path (`node_modules/.bin/<tool>`,
  `.venv/bin/<tool>`, or the ecosystem's equivalent), resolved from the REPOSITORY root
  rather than the process working directory. A missing install then fails loudly (exit
  127) instead of silently executing foreign code at a version nobody pinned — that is
  the intended behaviour.

### 3.4 Executable run — pre-commit AND gate tiers

- [ ] The pre-commit hook runs with every command ACTUALLY EXECUTED — not
  skipped — and exits 0. A run on a clean working tree with no staged changes is
  NOT sufficient: file-scoped commands (lint, unit, secret-scan) skip when
  nothing is staged, so the hook exits 0 without invoking a single tool and
  confirms nothing about tool resolution. Force real execution instead — run the
  hook against a representative staged file, or use the runner's all-files form
  (`lefthook run pre-commit --all-files`, or `--force`) — and confirm every
  command runs and exits 0 with NO `command not found` / exit 127. This is what
  actually confirms all hook commands are resolvable — in particular that every
  project-local tool invoked by its pinned path (§3.3) is actually installed, since a
  missing install is exactly what that rule turns into a loud failure.
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
- [ ] That version assertion covers the HOOK RUNNER ITSELF. Resolve the runner exactly
  as the installed shim resolves it — the runner-path environment override first, then
  the path configured in the managed hook config, then `PATH` — and assert THAT
  executable's `--version` against the manifest's `hookRunner.version`. Two things make
  this mandatory rather than tidy. The runner decides whether any check runs at all, so
  an unasserted runner leaves the recorded `hookRunner.version` a claim rather than a
  control — a globally installed runner at a different version can execute every hook
  while the manifest and the lockfile both read correctly. And the assertion must probe
  the binary the shim will actually execute: asserting a bare-name lookup while the shim
  is configured to run a pinned path asserts nothing about the run, and reinstalling a
  shim cannot change what a shell's `PATH` resolves.

### 3.5 Idempotency (no-op re-generation)

- [ ] Re-running the skill with identical inputs produces no file changes.
  Concretely: after generation, running the skill again must leave `git status`
  clean (no new or modified files). This enforces constitution §4.4. "Identical
  inputs" includes the resolved tool versions: if upstream has since shipped a newer
  version, a re-run that picks it up will (correctly) change the manifest — that is an
  upgrade, not an idempotency failure. Idempotency is about the writer not duplicating
  or churning managed blocks for the SAME inputs.

### 3.6 Deterministic checker

Constitution §4.8 governs this section — who decides conformance, and that model
judgment interprets only what the checker could not decide. What follows is the
operational detail alone: which tool runs, in which mode, and what it is pointed at.

**The checker is a GENERATION-TIME and doctor tool, never wired into the harness it
checks.** `claudeconf-check.mjs` ships with the plugin and runs FROM the plugin against
a project directory — during generation, during an upgrade, and whenever the doctor
runs. A GENERATED HARNESS NEVER INVOKES IT. Wiring it in would make the harness depend
on this skill at execution time, which constitution §4.8 forbids outright. What a
generated harness runs instead is its own project-check assertion (§1) — at profile 6 the
vendored bundle, a fixed copy run on the harness's own pinned Node runtime, which needs the
plugin neither installed nor reachable. The one
repository whose gate legitimately calls the bundled checker is claudeconf's own: there
it is the product under test, not a dependency of the harness.

- [ ] The bundled checker runs against the generated harness rooted at the project and
  reports NO failing check before the human-review gate:
  `node <plugin-root>/skills/claudeconf/scripts/claudeconf-check.mjs --root . --enforce`.
  Its full per-check output — one verdict per check, each with the file, line, or command
  it read — is attached to the gate presentation, because the verdicts ARE the evidence
  the human reviews.
- [ ] That run uses **`--enforce`** — the default, and the mode the generation flow
  uses, together with claudeconf's own gate job and CI step. Enforcing means "cannot
  verify" is not a pass: an unsupported or missing `constitutionVersion`, a malformed or
  unterminated managed region, an unparseable manifest / workflow / hook config, and any
  CRITICAL check that cannot be established all FAIL. Without this, editing the recorded
  profile to a value no bundled profile knows would green the arbiter with one
  character.
- [ ] The CRITICAL set is the checks this contract makes load-bearing, and each of them
  fails when unverifiable: milestone→job wiring against the merged hook config,
  managed-job identity and raw-layer ownership, the CI pre-merge trigger, gate↔CI tool
  equivalence, signal-bearing, every `projectChecks` resolution, the runner VERSION
  assertion, and the reconciliation of the manifest's pins against the configs and
  lockfiles that reference them.
  The set is enumerated in the checker and that enumeration is authoritative; this
  sentence describes it and must be reconciled with it whenever either moves. Two things
  are deliberately NOT in it, and both are consequences of rules stated elsewhere in this
  document: the runner-pinning PATH fields, because a shipped exemplar has no installed
  dependency tree and §3.2 makes that unverified rather than failed; and the CI header
  constraints, which fail on what they can read and do not claim to be establishable in
  the absence of a readable workflow.
- [ ] **`--advisory`** — the doctor's mode — leaves an unverifiable check unverified and
  exits 0. It reports; it does not gate. A harness is never declared conforming, and no
  human-review gate is ever satisfied, from an advisory run. Note what advisory does NOT
  soften: a check that is DEMONSTRABLY broken still fails in this mode (§3.3's inert
  gate/CI commands, for one). Advisory withholds judgment on the unknown, never on the
  known-bad.
- [ ] Local machine state is not harness content: hooks not being installed in THIS
  working copy is reported as unverified in BOTH modes and is explicitly NOT in the
  critical set. What IS in the critical set is the shim's CONTENT once hooks are
  installed (§3.2).
- [ ] **`--profile <n>`** — checking against a TARGET profile for an upgrade dry run —
  runs the target profile's checks IN ADDITION TO the recorded profile's, never instead
  of them, so a dry run cannot hide a regression against what the harness currently
  claims.

---

## 4. Relationship to the Constitution

This contract operationalises the constitution:

| Constitution section | Contract section |
| --- | --- |
| §1 Tier Ladder | §2.3 `milestones[*].tiers` field rules; §2.4 managed job/step names; §3.3 milestone wiring and gate↔CI tool equivalence |
| §2 Milestone Gates | §2.2 nine required milestone keys; §3.1 manifest completeness |
| §3 Non-Negotiables | §1 required artifacts (CI workflow, e2e scaffold); §3.3 CI trigger check |
| §4.1 Pinned versions | §2.3 version field rules; §3.1 version check; §3.4 tool + hook-runner version assertions |
| §4.2 No network in the unit tier | §3.3 no-fetch and no-package-runner checks; §1 lockfile/frozen-install row |
| §4.3 Deterministic | §2.1 determinism rule (no volatile fields) |
| §4.4 Idempotent + ownership split | §1 git-hook config and project-check assertion rows; §2.3 `projectChecks`, `agentHardening.managedHooks`; §2.4 managed names; §3.2 split/ownership existence checks; §3.3 managed-job identity + raw-layer ownership; §3.5 no-op re-generation check |
| §4.5 Scope guard | §1.1 scope guard artifact; §3.2 scope guard existence check |
| §4.6 Supply-chain admission | §1 dependency-update + lockfile rows; §3.2 cooldown/lockfile checks |
| §4.7 Merge trust root | §1 suppression-ledger + control-plane + agent-hardening rows; §2.3 `agentUse`, `agentHardening`; §3.2 ledger/ownership/deny checks |
| §4.7 rule 4 Delegability | §1 delegability-record row; §1.2 record format; §3.2 record + arbiter-set + advisory-template checks |
| §4.8 Deterministic verification | §3.6 deterministic checker (enforcing vs advisory, the critical set); §2.3 `constitutionVersion` field rule |
| §5 Hook-Runner Rule | §2.3 `hookRunner` + `runnerPinned` fields; §1 git-hook config row; §3.2 runner-pinning checks; §3.4 runner version assertion |
| §6 Versioning & Migration | §2.3 `constitutionVersion` field rule; §3.6 unsupported-profile handling |
