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

- **Most capable model, maximum reasoning** — every step that CREATES decisions the
  verifiers then enforce: detection (Step 2 — errors mis-scope everything), brainstorm
  (Step 3), research and tool selection (Step 4), the contract (Step 5), the INTEGRATION
  of Step 6 (scope, exclusions, scanner rules, e2e fidelity and OWNERSHIP are semantic; a
  subtly wrong but schema-valid wiring passes every check), the ownership gate, and the
  Step 8 presentation. Adversarial review of the result is top-tier work at any time.
- **Delegable to cheaper/faster models or subagents** — pure FAN-OUT that deterministic
  checks fully arbitrate: applying an already-decided pattern across files, running Step 7's
  commands and registry confirmations (the scripts decide; the model reads their output),
  and mechanical rewrites the executable gate re-proves.
- Verification itself is never model work. If a cheaper model's error would survive the
  checker plus the executable gate, that task was not delegable.

## Modes — decide this BEFORE Step 1

| Mode | Use it when | Steps |
| --- | --- | --- |
| `generate` | default: no harness, or the user asks for one | 1–9 |
| `upgrade` | the harness moves to a newer conformance profile | 1–2, then `modes.md` + the `migrations.md` delta, then 6–9 |
| `refresh` | tool VERSIONS move inside the current profile | 1–2, then `modes.md`, then 4–9; the profile never changes |

Pick by explicit user intent ("upgrade my harness", "refresh the pins"). Otherwise read
`.claudeconf/manifest.json`: a recorded `constitutionVersion` BEHIND the
`constitution-version` marker in `constitution.md` means you OFFER `upgrade` and let the
user choose. Never upgrade a harness nobody asked you to upgrade.

**`upgrade` and `refresh` both require `references/modes.md`** — read it in full first; it
holds each mode's order, the checker runs that frame it, and the full pin closure a
`refresh` rewrites. Two things are repeated HERE because getting either wrong is
unrecoverable:

- `upgrade` **STOPS TWICE** — at the ownership gate below, before ANYTHING moves, and again
  at the ordinary Step 8 gate.
- `constitutionVersion` is the **LAST** thing written. The field selects the checks the
  harness is judged by, so bumping it early makes every later verification answer the wrong
  question.

### The ownership gate (`upgrade` only — STOP; nothing moves before it)

Present a table covering EVERY job in the existing hook config and EVERY job and step in
the CI workflow, and take a per-row decision from the human:

| job / step | where it lives today | managed or project-owned | why |

**Everything defaults to project-owned, whatever it is called.** A name matching a contract
§2.4 managed token is not evidence of ownership — a project's own `lint`, `build`, `unit`,
or `e2e` job is entirely plausible, and absorbing it is the failure this profile closes. A
row becomes managed only by explicit approval here or a positive provenance match; profile 3
recorded no per-job provenance, so for 3→4 the answer is always the human. Say it at the
gate in these terms: **approving a job as "managed" authorises every future regeneration to
rewrite or delete it**, and that mis-classification is how a project's own check disappears
while the gate stays green. The reverse error costs only a redundant declaration — which is
why the default is asymmetric. Settle every managed-name COLLISION the same way, ADOPT or
RENAME, never silently either (migrations.md Steps A and B carry the mechanics).

## Step 1 — Load the invariants

Read the reference documents in full before touching the project. They are the source
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
- `references/wiring-principles.md` — the technology-AGNOSTIC correctness principles that
  make a harness actually run unattended: project-local tool resolution, coverage
  providers, CI runner/setup, formatter and scanner scoping, verify-by-executing,
  execute-the-bits-you-pinned, and ownership-before-sentinels (§9). They bind regardless of
  which tools you research — instantiate them per project.
- `references/agent-hardening.md` — the §4.7 instantiation guide: control-plane ownership
  derivation, the suppression ledger, the deny module + SessionStart hook, and the honest
  limits (configured ≠ enforced; permissions ≠ isolation). Binds whenever `agentUse` is
  true, which is the default.
- `references/migrations.md` — the per-profile delta lists and the procedure around them,
  and `references/modes.md` — the mechanics of `upgrade` and `refresh`. Both are REQUIRED in
  those two modes; skip both in `generate`, which always emits the current profile.

The patterns under `references/patterns/` (one per stack, plus `security.md`,
`ci-github-actions.md`, `e2e.md`) are REFERENCE ANCHORS, not mandates — orientation for
Step 4, which is where the rule that governs them is stated.

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
- **An existing hook runner — NEVER install a second one.** Look for a runner's hook
  directory or config file, a staged-files runner declared in the package manifest, or the
  ecosystem's equivalent (`.husky/`, a `lint-staged` block in `package.json`,
  `.pre-commit-config.yaml`, `prek`, …). Two runners cannot coexist — they claim the same
  `.git/hooks/*` or `core.hooksPath`, so the last one installed wins and the other's checks
  silently stop running. Offer exactly two options at the review gate:
  - **Migrate to lefthook** — each existing command becomes a NAMED job in the PROJECT-OWNED
    root `lefthook.yml` with a `projectChecks` entry, and the old runner's config and
    installed hooks are REMOVED in the same change. A preserved command enters the managed
    `.claudeconf/lefthook.yml` only if the human ADOPTS it as a generated milestone at the
    gate; a matching name never authorises that, and a preserved name colliding with the
    managed set is RENAMED out of it (contract §2.4).
  - **Preserve the existing runner** — only when all three constitution §5 criteria hold.

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
  `references/patterns/` as thin, optional orientation — never a mandate. Research the best
  tool for THIS project per milestone and its latest stable version (web search, the
  project's docs, the ecosystem's de-facto standards). The harness must fit the project in
  front of you, not a template; if an anchor is stale or a poor fit, diverge. Whatever you
  pick is subject to `references/wiring-principles.md`.
- **Research the RUNTIME version too.** It is the one pin a harness inherits rather than
  chooses, and it goes stale silently — no milestone check notices an EOL runtime. Look up
  the current Active LTS (or the ecosystem's equivalent) against its own release schedule,
  confirm it is not EOL on the generation date, and NEVER emit an EOL runtime. Record it in
  a version FILE the CI reads (`.nvmrc`, `.python-version`, `.tool-versions`) and point the
  setup step at that file, so a developer's shell and CI cannot disagree. Raising the
  project's declared SUPPORT floor (`engines.node`, `requires-python`) is a DIFFERENT
  decision and belongs to the project: it drops support for that project's users, and
  alongside a strict-engine setting it turns the project's own jobs on an older runtime into
  a hard install failure — a harness breaking a project-owned check from a distance.
- **Prefer the project's existing tool** when it already covers a milestone with
  equivalent coverage (e.g. ESLint/Prettier instead of switching to Biome) — do not force
  a migration that creates churn without benefit.
- Preserve the security conventions from `references/patterns/security.md`: secret scan and
  SAST are deterministic and network-free (no live verification, no auto-config, pinned
  offline rulesets). The tool may differ; the offline/pinned convention is kept. Be honest
  about coverage — the default rulesets are SEED-level, so a green SAST or secret-scan check
  is not a security guarantee. Offer to vendor a curated ruleset at a pinned commit, and
  pair secret-scan with server-side push protection (local hooks are bypassable and do not
  scan history).
- Decide the hook runner per the constitution §5 rule: **lefthook** unless all three
  criteria for an ecosystem-standard runner hold, in which case document the choice with
  a short rationale.
- If the project genuinely cannot support a milestone yet (e.g. no test framework exists),
  you still include the milestone — the harness emits a prominent warning at the relevant
  tier rather than dropping it (constitution §2).

## Step 5 — Produce the contract

For each of the nine milestones, decide and record:

1. the **tool** (exact name),
2. the **pin** — a typed reference into the file that actually pins the tool, never a copied
   version (harness-contract.md §2.5): `npm-lock`/`uv-lock` for a tool the package manager
   installs (the lockfile entry, with the package manifest declaring that EXACT version),
   `tools-lock` for a binary provisioned by checksum (`.claudeconf/tools.lock.json`),
   `requirements` for a hash-locked Python tool, `runtime` for a tool that versions through
   the runtime (e.g. `npm-audit`). The pinned version itself is exact — never `^1.0`, `>=2`,
   `5.x`,
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

Record the CONFORMANCE claim too, or the harness claims a profile it does not satisfy:
`constitutionVersion` equal to the `constitution-version` marker in `constitution.md`;
`hookRunner` as `{ name, pin, runnerPinned }`; `runtimes` with at least `node` pinned to an
exact version file (the vendored support scripts run on it, in every stack);
`harnessScripts.version` = the bundle's `scripts/harness/VERSION`; `projectChecks[]` — always present, and
`[]` is an explicit declaration that the project owns no checks, never an omission; and
`agentHardening { denyPatterns, managedHooks }` whenever `agentUse` is true. Each has field
rules in harness-contract.md §2.3, and each is checked.

The manifest is also the SOURCE for the delegability record (§1.2): its arbiter list is
derived from `hookRunner`, `projectChecks[]`, and `ci.workflow`, so those fields have a
second consumer and a wrong value there now shows up twice.

## Step 6 — Wire the artifacts (ownership first, then idempotent blocks)

Generate EVERY row of harness-contract.md §1 — that table is the field-level spec and it is
normative. Apply every principle in `references/wiring-principles.md` as you wire each tool
you researched: that is where harnesses actually break (hook tool resolution, coverage
providers, CI runner/setup, formatter and scanner scoping).

**Ownership is decided BEFORE sentinels** (constitution §4.4, wiring-principles §9): a
sentinel block says where you WRITE, not what you OWN, and **a managed region only protects
what is outside it** — where one top-level key holds every job there is no outside, and a
wholesale rewrite takes the project's own jobs with it.

These six are the rows a generator gets wrong, and each is an ownership decision:

- **Git-hook config is SPLIT** — `.claudeconf/lefthook.yml` wholly managed (every generated
  job, no sentinels, rewritten wholesale) + the PROJECT-OWNED root `lefthook.yml` carrying
  one managed block: the `extends` list, plus any runner setting the runner does not merge
  across `extends` — determine which by EXECUTING the runner in hand, never from its
  documentation. Pin the runner (path, abort-on-missing, minimum version) and then re-run
  its `install`, because those values are baked into the hook shims. Project-owned jobs go
  BELOW the block; managed HOOK JOB names come from the closed set (contract §2.4), which is
  closed because the runner MERGES same-named jobs across layers. A §5 runner with
  no composition mechanism keeps a single-file managed region — record that `projectChecks`
  is then the ONLY protection a project-owned check has, an asymmetry rather than parity.
- **The CI managed block wraps ONLY managed jobs and steps**, and POSITION is what makes a
  CI job managed — being inside the region. Its job id is FREE: name it whatever fits the
  project, because nothing locates a CI job by its id (contract §2.4). Managed STEP names
  are not free — each must LEAD with its milestone's §2.4 token, since that is how a step is
  located. The header — `name`, `on`, `permissions`, `concurrency`, and the `jobs:` key
  itself — is written once OUTSIDE the block, stays project-owned, and is held to exactly
  that allowlist: workflow-level `env`/`defaults` alter managed jobs from outside, and a
  duplicate job id shadows a managed one. Project jobs go below the block, under a comment
  saying so.
- **The support scripts are VENDORED, never written.** Copy this skill's
  `scripts/harness/` directory — byte for byte, `lib/` included — to the project's
  `.claudeconf/bin/` and record `harnessScripts.version`. Wire them; do not author, adapt or
  "fix" them: every hand-written gate script the field produced was a new place for a check
  to pass without checking, and the checker fails a vendored file that differs from the
  bundle (A17). They are `check-project-checks.mjs` (wired at gate AND CI even when
  `projectChecks` is empty — it is what makes a regeneration that drops a project-owned check
  loud), `check-suppressions.mjs`, `assert-tool-versions.mjs`, `provision-tools.mjs` (reads
  `.claudeconf/tools.lock.json`), and `scan-tree.mjs`, through which the gate runs every
  whole-tree scanner so it scans the index, as CI does. They run on Node, in every stack: pin
  it in `runtimes.node` and install it in CI from that version file. Exclude
  `.claudeconf/bin/` from formatters, linters and the edit hook.
- **Required CI checks must run on every pull request** — no `if:` beyond `always()`, no
  repository secret: Dependabot and fork runs get none, and a skipped check reports green.
- **Updater config uses only keys the service accepts**: `default-days` only for
  `github-actions`, `docker` and the other ecosystems Dependabot does not version by SemVer —
  one unsupported key makes it reject the whole file.
- **`.claude/settings.json` is managed at ENTRY level, never as a whole file.**
  `agentHardening.managedHooks[]` is the authoritative record of the entries you own; a
  re-run rewrites exactly those and nothing else. The edit-tier `format` entry parses its
  payload with the project's own runtime by an absolute project-rooted path (no global
  helper, no bare interpreter, no on-demand package runner) and excludes lockfiles from its
  glob. Scope-guard wrapper here for a pentest engagement.
- **The e2e suite must DRIVE the project's primary interface** (web UI / HTTP service / CLI
  / library / mobile), unattended and with no live external credentials — pick by interface,
  never a browser default (`references/patterns/e2e.md`).
- **Agent-hardening artifacts are DERIVED, not hardcoded** (`agentUse: true`, the default):
  CODEOWNERS entries for the control plane you just generated, the suppression ledger plus
  its check at gate and CI, the deny module and SessionStart advisory
  (`references/agent-hardening.md`).
- **The delegability record is derived from the MANIFEST** (`agentUse: true`): write
  `.claudeconf/delegation.md` to the §1.2 format, listing as arbiters exactly the pinned
  gate invocation, every `projectChecks[].name`, and `ci.workflow`. Derive
  them from the manifest you just wrote — not from what you remember wiring — because the
  checker compares the two sets and a record assembled from memory is where they diverge.
  Keep the wording agent-agnostic: no vendor's orchestration primitives.

Then make re-runs safe: update managed blocks IN PLACE (`# >>> claudeconf managed >>>` …
`# <<< claudeconf managed <<<`), NEVER clobber or duplicate user-authored config outside
them, and declare what the PROJECT owns in `projectChecks` on the other side of the
boundary.

For an EXISTING / on-the-go project, fill gaps **ADDITIVELY**: keep the project's working
tools, CI steps, and configuration; add only the missing milestones/artifacts and your
managed blocks. A preserved check stays PROJECT-OWNED, renamed out of the managed set if it
collides; only a check the human ADOPTS at the Step 8 gate becomes managed. A milestone then
ends up covered TWICE — the preserved check and your pinned one — and that is the INTENDED
result, not a defect to tidy away: absorbing the project's job is exactly what the ownership
split forbids.

## Step 7 — Self-verify

Whether a harness conforms is decided by a deterministic checker, not by reading it
(constitution §4.8). Run it FIRST, and let it decide every check it covers:

- **Run the bundled checker:** `node <plugin-root>/skills/claudeconf/scripts/claudeconf-check.mjs
  --root . --enforce` — from a plugin install `<plugin-root>` is `${CLAUDE_PLUGIN_ROOT}`.
  `--enforce` is the default and the mode this procedure uses: "cannot verify" is not a
  pass, so an unsupported or missing profile, a malformed managed region, an unparseable
  artifact, and any critical check that cannot be established all FAIL. Its PASS and FAIL
  verdicts are AUTHORITATIVE — you interpret only the UNKNOWNs and never overturn either.
  **ATTACH ITS FULL PER-CHECK OUTPUT TO THE STEP 8 GATE**: the verdicts are the evidence the
  human reviews. Any FAIL means the harness is not complete — fix it and re-run.
- The checker READS the tree; it cannot RUN the harness, and it never becomes part of one
  (contract §3.6 — nothing a generated harness executes may invoke this skill). Three checks
  therefore stay yours (contract §3.4/§3.5), and they are where harnesses actually break:
  - **An executable pre-commit run**, every command EXECUTED rather than skipped, exit 0. A
    clean tree with nothing staged is insufficient — file-scoped commands skip, no tool is
    invoked, and tool resolution is left unproven. Force it (a representative staged file,
    or the runner's all-files / force mode) and confirm nothing exits 127.
  - **The GATE tier green too** — the whole-repo sequence CI mirrors. Pre-commit is
    staged-scoped and hides CI-only failures: a missing coverage provider, a whole-repo
    formatter hitting generated or nested configs, a secret scanner flagging `.git`.
  - **Idempotency** — re-running with identical inputs leaves `git status` clean.

The registry confirmation from Step 5 is also yours: the checker never touches the
network.

## Step 8 — HUMAN-REVIEW GATE (mandatory; STOP here)

STOP and present to the user, then WAIT for explicit approval before continuing:

1. **The chosen tools and WHY** — for each of the nine milestones: the tool, its pinned
   version, its tier(s), and a one-line rationale (why this tool, why this version, and —
   where relevant — why it diverges from or matches the pattern anchor or the project's
   existing tooling). Call out the hook-runner choice and any milestone that could not be
   fully supported.
2. **The diff** — the full set of files created or modified (and, for an existing project,
   confirmation that working config was preserved and changes are additive).
3. **The checker's per-check output**, unedited (Step 7). PASS and FAIL are the deterministic
   evidence; name every UNKNOWN and say what you concluded from it and why.
4. **Each control's BOUND, stated with the control.** `configured` is not `enforced` — the
   harness can scaffold CODEOWNERS and print the branch-rule checklist, only a human can
   apply it. The suppression gate's pattern set is incomplete by construction, so a clean
   result says what it compared, never that no weakening occurred. Default SAST and
   secret-scan rulesets are seed-level. Provisioning verifies at INSTALL time, not at use
   time. Deny rules govern the editor's Read/Edit only — Bash is not covered, and
   `runtimeIsolation` is not configured. A control presented without its bound is the same
   defect as a check that cannot fail.

In `upgrade` mode this gate comes AFTER the separate ownership gate above; re-present the
approved classification here alongside the diff, so the human sees what the approval moved.

Do NOT commit at this step. If the user requests changes, revise and re-run Steps 5–7,
then present the gate again. Only an explicit approval unblocks Step 9.

## Step 9 — Commit (only after approval)

After the user approves at the gate, stage the generated artifacts and commit with a
conventional-commit message describing the harness. Never push to `main`; use a feature
branch. Do not commit anything before the Step 8 approval.
