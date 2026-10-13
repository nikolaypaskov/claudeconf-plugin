# claudeconf

[![ci](https://github.com/nikolaypaskov/claudeconf-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/nikolaypaskov/claudeconf-plugin/actions/workflows/ci.yml)

A Claude Code skill that sets up a quality and security harness for a project: git hooks, CI, end-to-end tests, and pre-merge gates. It looks at the project, researches tools that suit it rather than relying on a fixed list, and writes a concrete, version-pinned configuration that you commit to the repository.

The skill only generates the harness. What it produces is ordinary tooling (lefthook, GitHub Actions, and your stack's own commands) that runs on its own, with no dependency on claudeconf or Claude at runtime.

## What it does

Point it at a repository and it will:

1. Detect the stack(s) and any harness that already exists.
2. Research a current, well-established tool for each milestone instead of assuming one.
3. Wire those tools across five tiers (edit, pre-commit, pre-push, gate, CI) covering nine milestones: format, lint, typecheck, unit, e2e, SAST, secret-scan, dependency-audit, and build. The gate and CI run the same full battery (Gate ≡ CI).
4. Add the **supply-chain admission** layer (constitution §4.6): release-age quarantine on install and update paths, committed lockfiles with frozen installs, docker images pinned by digest, and pinned workflow auditors (actionlint + zizmor).
5. Add the **agent-hardening** layer (constitution §4.7, on by default): control-plane CODEOWNERS entries, a suppression approval ledger checked at gate + CI, an editor-side deny module, and a bounded SessionStart advisory. Generated harnesses are **agent-hardened, never "agent-proof"** — the output states what is `configured` and what only branch rules can make `enforced`.
6. Vendor its **support scripts** (the suppression ledger, the project-check assertion, the version assertion, checksum provisioning, and an index-scoped scanner wrapper) from the plugin into `.claudeconf/bin/` instead of writing them per project, and record every tool version as a **pin into the lockfile that owns it** — so a Dependabot bump to that lockfile passes the gate with no other edit.
7. Verify the result, including a real gate-tier run, then stop and show you the chosen tools and the diff for approval before anything is committed.

On an existing project it only fills gaps, using managed blocks so it does not overwrite your configuration. The generated harness is deterministic: pinned versions, no network calls in the unit tier, and repeatable re-runs.

## What ships in the plugin

- **`/claudeconf`** — the harness-generator skill.
- **`claudeconf:harness-doctor`** — an advisory, read-only subagent that checks an
  existing harness against its RECORDED constitution profile: manifest/wiring/
  drift checks with cited evidence (PASS/FAIL/UNKNOWN), profile-upgrade
  availability, and — only when you ask for `--online` — registry-existence
  probes and read-only GitHub branch-protection checks via `gh api` (that mode
  performs network access and needs `gh` auth; it is disclosed and opt-in). The
  doctor never edits, regenerates, or applies anything. Run it on a
  high-capability model: PASS/FAIL judgments hinge on evidence sufficiency,
  which nothing downstream re-checks.

## Requirements

- To **run the skill**: [Claude Code](https://claude.com/claude-code) and git.
  Verified against Claude Code 2.1.214; the plugin needs `skills/` + `agents/`
  plugin discovery, and generated harnesses use `SessionStart` hooks and
  `permissions.deny` rules (current Claude Code releases support all of these).
- For the **generated harness** to run: standard tooling you already have or can install — a hook runner (lefthook by default), your stack's own tools (formatter, test runner, etc.), and Docker for the CI security tier (semgrep and trufflehog run as pinned images; GitHub Actions provides Docker). The skill researches and pins exact versions.

## Install

```text
/plugin marketplace add nikolaypaskov/claudeconf-plugin
/plugin install claudeconf@claudeconf
```

(`claudeconf@claudeconf` reads oddly but is correct — it is `plugin-name@marketplace-name`, and both are named `claudeconf`.)

## Use

Run it in any project:

```text
/claudeconf
```

Review the proposed tools and the diff at the gate, approve, and it commits the harness on a feature branch.

### Check an existing harness

```text
Use the harness-doctor agent to check this repo's harness.
```

The doctor validates the harness against its RECORDED constitution profile —
manifest completeness, wiring, drift between pins and reality — reporting
`PASS`/`FAIL`/`UNKNOWN` with cited evidence, plus "profile upgrade available"
when a newer profile exists. Add `--online` to also probe registries and (via
read-only `gh api`) whether branch protection actually enforces the CODEOWNERS
entries. It never edits or applies anything.

### Approving a suppression

When a change adds or broadens a lint/SAST/secret-scan suppression (or widens a
scanner exclusion), the `suppressions` check fails and prints a fingerprint. To
approve: add `{fingerprint, file, rule, rationale}` to
`.claudeconf/suppressions.json` **in the same change**. The ledger is
control-plane material under CODEOWNERS, so the code-owner review of that edit
IS the recorded human sign-off — the check never turns green by re-running.

### After generation: enforce

The harness can only scaffold (`configured`). To make the trust root `enforced`,
follow the printed checklist: branch rules that require code-owner review,
dismiss stale approvals, require approval of the latest push, and allow no
bypass actors.

### Opting out of agent hardening

`agentUse: false` (with a recorded rationale) can be chosen at the review gate;
it drops the agent-hardening module and every agent-hardened claim. Flipping the
field later is itself a control-plane change requiring human review.

**New or empty project?** claudeconf works best alongside the [`superpowers:brainstorming`](https://github.com/obra/superpowers) skill — it brainstorms the project's purpose, stack, and constraints first, then generates a harness that fits those decisions. With the superpowers plugin installed, claudeconf invokes brainstorming automatically for new projects; without it, it brainstorms inline (the dedicated skill gives better results).

## What it generates

[`examples/node-app/`](examples/node-app/) is a complete generated harness for a small Node/TypeScript project at **constitution profile 6** — the dev repository's own exemplar, copied verbatim, which its CI executes end to end on every PR. It contains a project-owned `lefthook.yml` that `extends` the wholly managed `.claudeconf/lefthook.yml` (full-battery gate), a hardened `.github/workflows/ci.yml` (SHA-pinned actions, digest-pinned images, least-privilege permissions, `persist-credentials: false`, frozen installs, required checks that run on bot and fork PRs alike), `.github/dependabot.yml` with release-age cooldowns, `.npmrc` install-path quarantine, the control-plane CODEOWNERS entries, the agent-hardening `.claude/settings.json`, the delegability record, the vendored support scripts in `.claudeconf/bin/`, the checksum tool lock, and the recorded `.claudeconf/manifest.json`:

```json
{
  "constitutionVersion": "6",
  "agentUse": true,
  "stacks": ["node"],
  "hookRunner": { "name": "lefthook", "runnerPinned": true,
                  "pin": { "kind": "npm-lock", "key": "lefthook" } },
  "milestones": {
    "format": { "tool": "biome", "tiers": ["edit", "gate", "ci"],
                "pin": { "kind": "npm-lock", "key": "@biomejs/biome" } },
    "sast":   { "tool": "semgrep", "tiers": ["pre-push", "gate", "ci"],
                "pin": { "kind": "requirements", "path": ".claudeconf/tools-requirements.txt",
                         "key": "semgrep" } }
  },
  "ci": { "auditors": [ { "tool": "actionlint", "pin": { "kind": "tools-lock", "key": "actionlint" } } ] },
  "runtimes": { "node": { "kind": "version-file", "path": ".nvmrc", "key": "node" } },
  "harnessScripts": { "version": "0.6.0" }
}
```

(Trimmed — the real file records all nine milestones; every pin resolves to an exact version in the file it names, and the bundled checker fails one that does not.) Nothing in there runs claudeconf or Claude; it is plain, pinned tooling you own.

## How it stays generic

claudeconf fixes a small set of invariants and researches everything else:

- `references/constitution.md` defines the tier ladder, the nine milestone gates, and the determinism and safety invariants.
- `references/wiring-principles.md` holds the rules every harness has to get right regardless of language: resolving project-local tools in hooks, installing coverage providers, matching the CI runner and setup to the stack, scoping formatters and scanners, and verifying by actually running things.
- `references/harness-contract.md` specifies the output artifacts, the `.claudeconf/manifest.json` schema, and the self-verify checklist.
- `references/agent-hardening.md` defines the merge trust root: derived control-plane ownership, the suppression-ledger protocol, the deny module with its residual gaps named, and why permission rules are defense-in-depth rather than isolation.
- `references/doctor-checklist.md` is the evidence-driven procedure the harness-doctor agent executes.
- `references/migrations.md` is the complete delta between adjacent profiles, which the skill's `upgrade` mode applies.
- `scripts/claudeconf-check.mjs` is the deterministic conformance checker; `scripts/harness/` is the support-script bundle every harness vendors, and `scripts/harness-catalog.json` is what the checker verifies a vendored copy against.
- `references/patterns/` holds thin per-stack starting points that research can override.

Because it commits to principles rather than a fixed tool list, the same skill works for a Node service, a Python CLI, an Elixir app, or a Swift package.

## Limitations

- It **stops at a human-review gate** and never auto-commits: you approve the tools and the diff first.
- It **fills gaps additively** on existing repos (managed blocks); it will not migrate a toolchain that already works.
- The default **SAST and secret-scan rulesets are seed-level**, not comprehensive: see [SECURITY.md](SECURITY.md). Extend them (vendor a curated pack, add CodeQL, enable server-side push protection) before relying on a green check as a guarantee.
- Stacks are research-driven; per-stack starting anchors exist for Node, Python, Elixir, Swift, and Kotlin. Other stacks work via research, with the gate-tier self-verify as the safety net.
- The **CI security tier needs Docker** (semgrep and trufflehog run as pinned images).
- The vendored support scripts run on **Node in every stack**, so a Python-only project's CI also sets up Node (pinned through its runtime version file).
- **Agent-hardened, never "agent-proof"**: generated files are `configured`; only branch rules a human sets make them `enforced`. Editor-side deny rules are defense-in-depth, not isolation (spawned interpreters are not covered) — high-assurance autonomous use needs OS-level sandboxing, which the harness documents but does not generate.

## License

[MIT](LICENSE), Nikolay Paskov.
