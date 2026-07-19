---
name: claudeconf
description: Set up or harden a project's quality and security pipeline — git hooks, CI, tests, and pre-merge gates. Researches and pins tools that fit the project's stack instead of using fixed choices, then wires a standard-tool harness you own. Use when initializing a repo, adding CI or pre-commit checks, hardening an existing pipeline, or migrating tooling.
---

Wire a pinned, standard-tool quality + security harness for the current project by
researching the best CURRENT tools for its stack(s) and generating the artifacts the
harness contract requires. The harness covers nine milestones across five tiers; it is
deterministic, network-free in the unit tier, and idempotent. You research the tools —
this procedure never hardcodes per-language choices.

Follow these steps IN ORDER. Do not skip the human-review gate. Do not commit before
approval.

## Capability routing (who executes what)

Route by VERIFIABILITY — and "verifiable" means semantically checked by a
deterministic verifier downstream, not merely schema-valid or exiting 0:

- **Most capable model, maximum reasoning** — every step that CREATES decisions
  the verifiers then enforce: detection (Step 2 — errors mis-scope everything),
  brainstorm (Step 3), research and tool selection (Step 4), the contract
  (Step 5), the INTEGRATION of Step 6 (scope/exclusion/scanner-rule/e2e-fidelity
  choices are semantic; a subtly wrong but schema-valid wiring passes checks),
  and the human-review-gate presentation (Step 8). Adversarial review of the
  result, any time, is top-tier work.
- **Delegable to cheaper/faster models or subagents** — pure FAN-OUT whose
  outputs deterministic checks fully arbitrate: applying an already-decided
  wiring pattern across files/fixtures, running the Step 7 self-verify commands
  and registry confirmations (scripts and pinned tools decide; the model only
  reads their output), and mechanical rewrites (version bumps, lockfile
  regeneration) that the executable gate re-proves.
- Verification itself is never model work. If a cheaper model's error would
  survive the §3 checklist plus the executable gate, that task was not delegable.

## Step 1 — Load the invariants

Read both reference documents in full before touching the project. They are the source
of truth for everything that follows; if anything below seems to conflict with them, the
reference wins.

- `references/constitution.md` — the FIXED invariants: the five-tier ladder, the nine
  milestone gates and their default tiers, the non-negotiables (code quality, security,
  autonomous e2e, GitHub CI), the determinism/safety invariants (pinned versions, no
  network in the unit tier, deterministic, idempotent managed-block writes, scope guard),
  and the hook-runner rule (lefthook by default; an ecosystem-standard runner only when
  ALL THREE §5 criteria hold).
- `references/harness-contract.md` — the OUTPUT spec: the required artifact set, the
  `.claudeconf/manifest.json` schema and field rules, and the self-verify checklist.
- `references/wiring-principles.md` — the technology-AGNOSTIC correctness principles for
  wiring any harness so it actually runs unattended (project-local tool resolution in
  hooks, coverage providers, CI runner/setup matching the stack, formatter/scanner
  scoping, verify-by-executing, execute-the-bits-you-pinned). These bind regardless of
  which tools you research — instantiate them per project.
- `references/agent-hardening.md` — the constitution §4.7 instantiation guide:
  control-plane ownership derivation, the suppression approval ledger, the
  editor-side deny module + SessionStart hook, and the honest limits
  (configured ≠ enforced; permissions ≠ isolation). Binds whenever `agentUse` is
  true — which is the default.

The patterns under `references/patterns/` (one per stack — node, python, elixir, swift,
kotlin — plus `security.md`, `ci-github-actions.md`, `e2e.md`) are REFERENCE ANCHORS,
not mandates. Read the relevant ones for orientation in Step 4; you may diverge from them
when current research or the project's existing tooling justifies it. The tier placement
and blocking/advisory semantics from the constitution are fixed; the specific tool that
fills each slot is not.

## Step 2 — Detect the project

Inspect the working directory to determine:

- **New vs existing.** A project is EXISTING (on-the-go) if it already has source code,
  a dependency manifest (e.g. `package.json`, `pyproject.toml`, `mix.exs`, `Package.swift`,
  `build.gradle`), or working CI/hook config. Otherwise treat it as NEW.
- **Stacks and frameworks present.** Identify every language/runtime and framework in use
  (web app, API, CLI, library) by reading manifests, lock files, config, and directory
  layout — e.g. Node/TypeScript, Python, Elixir/Phoenix, Swift, Kotlin/JVM, and any
  front-end/back-end split. A repo may have more than one stack; cover all of them.
- **Existing harness pieces.** Note any pre-existing hook runner config, CI workflow,
  formatter/linter/test/SAST tools, and e2e suite. You will preserve these.

## Step 3 — NEW project only: brainstorm first

If the project is NEW, invoke the **`brainstorming`** skill BEFORE researching or
generating anything, to capture the project specifics (purpose, stack intent, framework,
target platform, deployment, any security/pentest context). Use its output to inform the
stack detection and tool research in the following steps. For an EXISTING project, skip
this step — the codebase already encodes those decisions.

## Step 4 — Research the best CURRENT tools per milestone

For the detected stack(s), research the current best-in-class tool for each of the nine
milestones — `format`, `lint`, `typecheck`, `unit`, `e2e`, `sast`, `secret-scan`,
`dependency-audit`, `build`. Cover the web ecosystem and the broader ecosystem for each
stack.

- **Research is primary; the anchors are only a starting point.** Treat
  `references/patterns/` as thin, optional orientation — never a mandate. Research (web
  search, the project's docs, the ecosystem's de-facto standards, and current best
  practices for modern AI-assisted-coding harnesses) the best tool for THIS project per
  milestone and its latest stable version. The harness must fit the project in front of
  you, not a template; if an anchor is stale or a poor fit, diverge. Whatever tools you
  pick are subject to the generic `references/wiring-principles.md`.
- **Prefer the project's existing tool** when it already covers a milestone with
  equivalent coverage (e.g. ESLint/Prettier instead of switching to Biome) — do not force
  a migration that creates churn without benefit.
- Preserve the security conventions from `references/patterns/security.md`: secret scans
  and SAST must be deterministic and network-free (no live verification, no `--config
  auto`, pinned offline rulesets). The exact tool may differ; the offline/pinned
  convention is kept. Be honest about coverage: the default rulesets are SEED-level, so
  do not present a green SAST/secret-scan check as a security guarantee — offer to vendor
  a curated ruleset at a pinned commit (or add CodeQL at CI) and pair secret-scan with
  server-side push protection (see security.md).
- Decide the hook runner per the constitution §5 rule: **lefthook** unless all three
  criteria for an ecosystem-standard runner hold, in which case document the choice with
  a short rationale.
- If the project genuinely cannot support a milestone yet (e.g. no test framework exists),
  you still include the milestone — the harness emits a prominent warning at the relevant
  tier rather than dropping it (constitution §2).

## Step 5 — Produce the contract

For each of the nine milestones, decide and record:

1. the **tool** (exact name),
2. the **pinned version** (exact version or hash — never a floating range like `^1.0`,
   `>=2`, `5.x`; use the literal `"n/a"` only for tools versioned through the runtime,
   e.g. `npm-audit`),
3. the **tier(s)** it runs in (covering at least the default tier(s) from constitution §2).

Before recording a tool+version, CONFIRM the pair exists on its registry (e.g.
`npm view <pkg>@<version> version`). A pinned name/version you cannot confirm may be
hallucinated or squattable — treat it as a hard error, do not pin it
(`wiring-principles.md` §7).

This set of decisions IS the `.claudeconf/manifest.json` content (schema in
harness-contract.md §2). When a milestone uses a different tool per stack (polyglot
project), record a per-stack `tools[]` array (harness-contract.md §2.2.1) — never a
joined string like `"biome + ruff"`. Keep the manifest free of volatile fields — no
timestamps, no dates, no random seeds — so re-running on the same choices yields a
byte-identical file.

## Step 6 — Wire the artifacts (idempotent, managed blocks)

Generate the full artifact set from harness-contract.md §1, writing each one so a re-run
is safe. As you wire each tool you researched, apply every principle in
`references/wiring-principles.md` — that is where harnesses actually break (hook tool
resolution, coverage providers, CI runner/setup, formatter/scanner scoping):

- **Git-hook config** — `lefthook.yml` (default) or the ecosystem-standard runner's config
  when §5 allows. Wire every `pre-commit` / `pre-push` / `gate` milestone into its tiers.
- **CI workflow** — `.github/workflows/ci.yml`, mirroring the gate tier, covering all nine
  milestones, with pinned action versions (see `references/patterns/ci-github-actions.md`).
- **Edit-tier hook** — a `format` entry in `.claude/settings.json`: non-blocking, silent on
  success, NOT placed in a blocking tier. Include the scope-guard wrapper here if the
  harness is for a pentest engagement.
- **E2E scaffold + config** — identify the project's PRIMARY INTERFACE (web UI / HTTP
  service / CLI / library / mobile) and scaffold an autonomous suite that drives it: at
  least one test plus the framework config, runnable unattended with no live external
  credentials (see `references/patterns/e2e.md` — pick by interface, never a browser
  default). The suite directory fits the project (`e2e/` for a UI, the integration-test
  dir for a CLI/service). Record the framework + suite path.
- **Pinned tool configs** — one config file per tool a milestone uses (e.g. formatter,
  test runner, e2e, the pinned offline SAST ruleset), each pinning its tool version.
- **Agent-hardening artifacts** (`agentUse: true`, the default) — control-plane
  CODEOWNERS entries derived from the artifacts you just generated, the
  `.claudeconf/suppressions.json` ledger + its check script wired into gate + CI,
  and the `.claude/settings.json` deny module + SessionStart advisory hook
  (see `references/agent-hardening.md`). Print configured-vs-enforced honestly.
- **Manifest** — write the contract from Step 5 to `.claudeconf/manifest.json`.

Idempotency is mandatory (constitution §4.4): when inserting into files that may already
exist or hold user config, use **MANAGED BLOCKS** delimited by sentinel comments (e.g.
`# >>> claudeconf managed >>>` … `# <<< claudeconf managed <<<`). Update the managed block
in place on re-run; NEVER clobber or duplicate user-authored config outside the block.

For an EXISTING / on-the-go project, fill gaps **ADDITIVELY**: keep the project's working
tools, CI steps, and configuration; only add the missing milestones/artifacts and your
managed blocks. Do not overwrite a working formatter, test runner, CI job, or e2e suite.

## Step 7 — Self-verify

Run the self-verify checklist from harness-contract.md §3 in order. Any failing check
aborts with an actionable error naming the missing/invalid item; the harness is NOT
complete until all pass. In particular confirm:

- The manifest exists, is valid JSON, has all nine milestone keys, every entry has a
  non-empty `tool`, a `version` that is not a floating range (no `^ ~ > < = * x X`, except
  the literal `"n/a"`), and a non-empty `tiers` array covering the default tiers.
- All required artifacts exist (git-hook config, CI workflow, the `.claude/settings.json`
  edit-tier `format` hook, the non-empty e2e suite, a pinned config per manifest tool; and
  for a pentest context, the scope-guard wrapper plus a `.scope` file).
- Milestone wiring is correct: each milestone is wired into every tier in its `tiers`
  array; `format` is at the edit hook and not in a blocking tier; `e2e` is in CI and the
  gate tier.
- An executable run passes: the pre-commit hook runs with every command actually
  EXECUTED (not skipped) and exits 0. A clean tree with no staged changes is
  insufficient — file-scoped commands skip and no tool is invoked. Force real
  execution (a representative staged file, or `lefthook run pre-commit
  --all-files` / `--force`) and confirm no command fails with `command not found`
  / exit 127 — this is what proves every tool resolves on the hook's `PATH`.
- The GATE tier runs green too: run the full whole-repo gate sequence locally
  (full format/lint/typecheck, unit + coverage, e2e, SAST, whole-tree
  secret-scan, build — e.g. `lefthook run gate` or each CI command), not just
  pre-commit. Pre-commit is staged-scoped and won't surface CI-only failures — a
  missing coverage provider, a whole-repo formatter hitting generated/nested
  configs, or a secret scanner flagging `.git`. Catch them now, before the gate.
- Idempotency: re-running this procedure with identical inputs leaves `git status` clean
  (no new or modified files).

## Step 8 — HUMAN-REVIEW GATE (mandatory; STOP here)

STOP and present to the user, then WAIT for explicit approval before continuing:

1. **The chosen tools and WHY** — for each of the nine milestones: the tool, its pinned
   version, its tier(s), and a one-line rationale (why this tool, why this version, and —
   where relevant — why it diverges from or matches the pattern anchor or the project's
   existing tooling). Call out the hook-runner choice and any milestone that could not be
   fully supported.
2. **The diff** — the full set of files created or modified (and, for an existing project,
   confirmation that working config was preserved and changes are additive).

Do NOT commit at this step. If the user requests changes, revise and re-run Steps 5–7,
then present the gate again. Only an explicit approval unblocks Step 9.

## Step 9 — Commit (only after approval)

After the user approves at the gate, stage the generated artifacts and commit with a
conventional-commit message describing the harness. Never push to `main`; use a feature
branch. Do not commit anything before the Step 8 approval.
