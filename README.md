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
6. Verify the result, including a real gate-tier run, then stop and show you the chosen tools and the diff for approval before anything is committed.

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

[`examples/self-harness/`](examples/self-harness/) is the actual harness claudeconf maintains for this skill's own repository — committed verbatim at constitution profile 3, and validated by this repo's CI. It contains `lefthook.yml` (full-battery gate), a hardened `.github/workflows/ci.yml` (SHA-pinned actions, digest-pinned images, least-privilege permissions, `persist-credentials: false`, frozen installs, dependency-review, security, and workflow-audit jobs), `.github/dependabot.yml` with a release-age cooldown, `.npmrc` install-path quarantine, the control-plane CODEOWNERS entries, the suppression ledger + its checker, the agent-hardening `.claude/settings.json`, the vendored SAST rules, and the recorded `.claudeconf/manifest.json`:

```json
{
  "constitutionVersion": "3",
  "agentUse": true,
  "stacks": ["node"],
  "hookRunner": { "name": "lefthook", "version": "2.1.9" },
  "milestones": {
    "format": { "tool": "biome",   "version": "2.5.0",   "tiers": ["edit", "gate", "ci"] },
    "sast":   { "tool": "semgrep", "version": "1.168.0", "tiers": ["pre-push", "gate", "ci"],
                "rules": { "source": "hand-authored", "ref": "n/a", "license": "MIT" } }
  },
  "ci": { "auditors": [ { "tool": "actionlint", "version": "1.7.12" },
                        { "tool": "zizmor", "version": "1.27.0" } ] }
}
```

(Trimmed — the real file records all nine milestones, every version pinned.) Nothing in there runs claudeconf or Claude; it is plain, pinned tooling you own.

## How it stays generic

claudeconf fixes a small set of invariants and researches everything else:

- `references/constitution.md` defines the tier ladder, the nine milestone gates, and the determinism and safety invariants.
- `references/wiring-principles.md` holds the rules every harness has to get right regardless of language: resolving project-local tools in hooks, installing coverage providers, matching the CI runner and setup to the stack, scoping formatters and scanners, and verifying by actually running things.
- `references/harness-contract.md` specifies the output artifacts, the `.claudeconf/manifest.json` schema, and the self-verify checklist.
- `references/agent-hardening.md` defines the merge trust root: derived control-plane ownership, the suppression-ledger protocol, the deny module with its residual gaps named, and why permission rules are defense-in-depth rather than isolation.
- `references/doctor-checklist.md` is the evidence-driven procedure the harness-doctor agent executes.
- `references/patterns/` holds thin per-stack starting points that research can override.

Because it commits to principles rather than a fixed tool list, the same skill works for a Node service, a Python CLI, an Elixir app, or a Swift package.

## Limitations

- It **stops at a human-review gate** and never auto-commits: you approve the tools and the diff first.
- It **fills gaps additively** on existing repos (managed blocks); it will not migrate a toolchain that already works.
- The default **SAST and secret-scan rulesets are seed-level**, not comprehensive: see [SECURITY.md](SECURITY.md). Extend them (vendor a curated pack, add CodeQL, enable server-side push protection) before relying on a green check as a guarantee.
- Stacks are research-driven; per-stack starting anchors exist for Node, Python, Elixir, Swift, and Kotlin. Other stacks work via research, with the gate-tier self-verify as the safety net.
- The **CI security tier needs Docker** (semgrep and trufflehog run as pinned images).
- **Agent-hardened, never "agent-proof"**: generated files are `configured`; only branch rules a human sets make them `enforced`. Editor-side deny rules are defense-in-depth, not isolation (spawned interpreters are not covered) — high-assurance autonomous use needs OS-level sandboxing, which the harness documents but does not generate.

## License

[MIT](LICENSE), Nikolay Paskov.
