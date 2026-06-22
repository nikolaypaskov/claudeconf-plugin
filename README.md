# claudeconf

[![ci](https://github.com/nikolaypaskov/claudeconf-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/nikolaypaskov/claudeconf-plugin/actions/workflows/ci.yml)

A Claude Code skill that sets up a quality and security harness for a project: git hooks, CI, end-to-end tests, and pre-merge gates. It looks at the project, researches tools that suit it rather than relying on a fixed list, and writes a concrete, version-pinned configuration that you commit to the repository.

The skill only generates the harness. What it produces is ordinary tooling (lefthook, GitHub Actions, and your stack's own commands) that runs on its own, with no dependency on claudeconf or Claude at runtime.

## What it does

Point it at a repository and it will:

1. Detect the stack(s) and any harness that already exists.
2. Research a current, well-established tool for each milestone instead of assuming one.
3. Wire those tools across five tiers (edit, pre-commit, pre-push, gate, CI) covering nine milestones: format, lint, typecheck, unit, e2e, SAST, secret-scan, dependency-audit, and build.
4. Verify the result, including a real gate-tier run, then stop and show you the chosen tools and the diff for approval before anything is committed.

On an existing project it only fills gaps, using managed blocks so it does not overwrite your configuration. The generated harness is deterministic: pinned versions, no network calls in the unit tier, and repeatable re-runs.

## Requirements

- To **run the skill**: [Claude Code](https://claude.com/claude-code) and git.
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

If the project is new and has no code yet, claudeconf uses a brainstorming skill to capture the project's specifics first when one is available, and works through that inline otherwise.

## What it generates

[`examples/self-harness/`](examples/self-harness/) is the actual harness claudeconf generated for this skill's own repository — committed verbatim, and validated green by this repo's CI. It contains `lefthook.yml`, a hardened `.github/workflows/ci.yml` (SHA-pinned actions, least-privilege permissions, concurrency, caching, a dependency-review job, plus the semgrep and trufflehog security job), `.github/dependabot.yml`, the pinned tool configs, and the recorded `.claudeconf/manifest.json`:

```json
{
  "stacks": ["node"],
  "hookRunner": "lefthook",
  "milestones": {
    "format": { "tool": "biome",   "version": "2.5.0",   "tiers": ["edit", "ci"] },
    "lint":   { "tool": "biome",   "version": "2.5.0",   "tiers": ["pre-commit", "ci"] },
    "sast":   { "tool": "semgrep", "version": "1.167.0", "tiers": ["pre-push", "gate", "ci"] }
  }
}
```

(Trimmed — the real file records all nine milestones, every version pinned.) Nothing in there runs claudeconf or Claude; it is plain, pinned tooling you own.

## How it stays generic

claudeconf fixes a small set of invariants and researches everything else:

- `references/constitution.md` defines the tier ladder, the nine milestone gates, and the determinism and safety invariants.
- `references/wiring-principles.md` holds the rules every harness has to get right regardless of language: resolving project-local tools in hooks, installing coverage providers, matching the CI runner and setup to the stack, scoping formatters and scanners, and verifying by actually running things.
- `references/harness-contract.md` specifies the output artifacts, the `.claudeconf/manifest.json` schema, and the self-verify checklist.
- `references/patterns/` holds thin per-stack starting points that research can override.

Because it commits to principles rather than a fixed tool list, the same skill works for a Node service, a Python CLI, an Elixir app, or a Swift package.

## Limitations

- It **stops at a human-review gate** and never auto-commits: you approve the tools and the diff first.
- It **fills gaps additively** on existing repos (managed blocks); it will not migrate a toolchain that already works.
- The default **SAST and secret-scan rulesets are seed-level**, not comprehensive: see [SECURITY.md](SECURITY.md). Extend them (vendor a curated pack, add CodeQL, enable server-side push protection) before relying on a green check as a guarantee.
- Stacks are research-driven; per-stack starting anchors exist for Node, Python, Elixir, Swift, and Kotlin. Other stacks work via research, with the gate-tier self-verify as the safety net.
- The **CI security tier needs Docker** (semgrep and trufflehog run as pinned images).

## License

[MIT](LICENSE), Nikolay Paskov.
