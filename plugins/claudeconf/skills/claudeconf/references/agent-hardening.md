# Agent Hardening (constitution §4.7)

Every generated harness assumes AI coding agents will drive the repository
(`agentUse: true`). The harness is **agent-hardened, never "agent-proof"**: the
deterministic gates are the authoritative boundary; everything here narrows the
paths around them. Two states are always reported separately:

- `configured` — the artifacts exist in the repo (what generation can do).
- `enforced` — the platform actually requires them (what only a human with admin
  rights can do). Never present configured as enforced.

## Threat model (what these controls are for)

An agent with write access can, accidentally or through prompt injection: weaken
the harness itself (edit a workflow, an exclude file, a config), silence a
control (add a suppression), exfiltrate secrets it can read, or merge unreviewed
changes. The merge boundary — deterministic CI + human review of protected paths
— is the control that holds even when the agent misbehaves; editor-side rules
only reduce how often it gets that far.

## 1. Control-plane ownership (§4.7.1)

Derive the protected surface FROM the generated harness — never a hardcoded list:

- CI workflows (`.github/workflows/**`) and the workflow-audit configuration
  (e.g. `zizmor.yml`)
- the hook-runner config (`lefthook.yml` / `.pre-commit-config.yaml`)
- every pinned tool config the manifest references
- the manifest (`.claudeconf/**`) and all lockfiles
- scanner exclude/ignore files
- provisioning scripts and their recorded checksums
- the suppression ledger
- `.claude/settings.json` (the agent's own permission surface)
- `.github/CODEOWNERS` itself

GitHub implementation: CODEOWNERS entries for each of the above. Then print the
ENFORCEMENT checklist — branch rules that (a) require code-owner review, (b)
dismiss stale approvals, (c) require approval of the most recent push, (d) have
no bypass actors. Without those four, CODEOWNERS is advisory and the state is
`configured` only.

## 2. Suppression approval ledger (§4.7.2)

A suppression is any mechanism that silences a control: inline tokens
(`biome-ignore`, `eslint-disable`, `nosemgrep`, `trufflehog:ignore`,
`type: ignore`, `noqa`, zizmor ignores) AND config-level widenings (a new entry
in a scanner exclude file, a broadened ignore glob, a disabled rule).

- `.claudeconf/suppressions.json` holds approved entries:
  `{ "fingerprint", "file", "rule", "rationale" }` — fingerprint is a stable hash
  of file + rule + the suppressed line's content, so moving or broadening a
  suppression changes it.
- The check script diffs the working tree against the merge base and fails on
  any added/changed suppression token or watched-config widening whose
  fingerprint is absent from the ledger. Removal of suppressions never fails.
- Approval protocol: the agent (or human) adds the ledger entry IN THE SAME
  change; because the ledger is on the protected surface, the code-owner review
  of that change IS the recorded human sign-off. The check turns green only via
  a reviewed ledger edit — never by re-running.

## 3. Editor-side deny module (default-on, defense-in-depth)

`permissions.deny` entries in `.claude/settings.json` make secret-bearing paths
invisible to the agent. Every pattern is `**/`-anchored so a nested path is covered
as well as a root one (`apps/api/.env` is not otherwise matched), and each shape is
denied for Read AND Edit:

`**/.env`, `**/.env.local`, `**/.env.*.local`, `**/secrets/**`, `**/id_rsa*`,
`**/id_ed25519*`, `**/id_ecdsa*`, `**/*.key`

The exact strings the harness owns are recorded verbatim in the manifest as
`agentHardening.denyPatterns`, so a re-run reconciles its own set and leaves
project-added deny entries untouched (contract §2.3). Named residual gaps — say
them, do not paper over them:

- Deny rules cannot express exceptions, so `.env.example` must not match the
  patterns you deny (keep `.env.example` out of the denied shapes rather than
  denying `.env*` wholesale); blanket `**/*.pem` would also hide public certs.
- **Deny rules govern the editor's Read/Edit tools only — Bash is not covered**
  (`cat .env` runs, and so does a spawned interpreter). This module narrows
  ACCIDENTAL exposure; it is not isolation. High-assurance autonomous use needs
  OS-level sandboxing and protected environment variables (see the platform's
  sandboxing documentation); a harness that has not configured that isolation
  reports `runtimeIsolation: not-configured`.

The same gap applies to HOOKS, for the same structural reason: a `PreToolUse` hook
is bound to a matcher over TOOL names, so a hook matching `Edit|Write|MultiEdit`
never sees `Bash`, and an edit blocked at the editor tool can be written as the
identical bytes through a shell heredoc. That is observed, not hypothetical: during
this profile's own development a `security-guidance` plugin hook with matcher
`Edit|Write|MultiEdit` blocked an edit to a semgrep rules file — the file
legitimately contains the literal pattern the rule matches on — and the implementing
agent completed the same edit through `Bash` without the hook firing. Two things
follow. Tool-scoped hooks and deny rules are defense-in-depth against ACCIDENT,
never a boundary against INTENT; the deterministic gates at commit, gate, and CI,
behind a merge boundary a human owns, are the boundary (constitution §4.7). And a
matcher that fires on file CONTENT rather than on effect false-blocks legitimate
security work, which is a second reason not to place authority there.

## 4. SessionStart advisory hook (default-on)

Injects ONE bounded line of context at session start, built from
schema-validated manifest values only (never free text):

> claudeconf harness, profile <constitutionVersion> (declared): run
> `<runner-specific gate command>` before any PR. Delegation rule:
> see `.claudeconf/delegation.md`.

"Declared", not "verified" — the hook reports what the manifest claims, the gate
verifies it. The template is FIXED and the ONLY values interpolated into it are
`constitutionVersion` and the runner's gate command; nothing else, because manifest
strings become prompt context. Do not enumerate the full tool list.

The second sentence is a literal pointer, added at profile ≥5, and it is a POINTER
rather than a summary on purpose: the rule is long enough that any one-line
paraphrase of it would drop either the licensing half or the forbidding half, and a
half-rule read at session start is worse than a pointer to the whole one. The
advisory is the only channel the HARNESS controls that reliably reaches an agent's
context — a project's own instruction files reach it too, but the harness does not own
them and may not edit them — which is why the record gets a line here at all. It stays
two sentences, and the record stays the authority (§7).

This entry and the edit-tier format hook are managed at ENTRY level: a re-run
rewrites exactly the entries the manifest names in `agentHardening.managedHooks[]`
and leaves every other key and entry in `.claude/settings.json` alone. The manifest
is the AUTHORITATIVE record of that ownership — a `_claudeconf` marker inside an
entry is human-readable convenience, since properties nested in a third party's
settings schema are not a record this harness controls (contract §2.3).

## 5. Stop hook — experimental opt-in ONLY

A Stop hook that runs the pre-commit tier is NOT generated by default: agents
normally yield with unstaged edits (staged-scope checks then execute nothing),
it fires on conversational stops (questions, blockers), and repeated blocks risk
continuation loops (`stop_hook_active` must be honored; the platform force-stops
after repeated continuations). If a team wants a strict autonomous session mode,
document it as experimental with one-shot escape semantics — never as a quality
gate. The authoritative gates remain commit/push hooks and CI.

## 6. Doctor

`claudeconf:harness-doctor` (bundled with the plugin) checks a harness against
its RECORDED profile: evidence-driven, advisory, read-only; PASS only with cited
evidence, UNKNOWN on ambiguity; `--online` (registry + `gh api` protection
probes) is opt-in. See `doctor-checklist.md` for the procedure.

## 7. Delegability record (§4.7 rule 4, profile ≥5)

`.claudeconf/delegation.md` is where the harness tells the agents working in the
project when delegating to a cheaper or faster model is safe. The rule is two-sided —
delegate when one of the project's own deterministic verifiers decides the result,
never when the mistake could survive all of them — and both halves ship, because the
two failure modes are symmetric: an agent that fans work out with no criterion, and an
agent that never fans out because nothing told it what makes fanning out safe.

Generate it from the manifest, never from prose about the project:

- The arbiters are the PINNED gate invocation (the runner path the hook config declares
  plus the gate subcommand), every `projectChecks[].name`, and `ci.workflow` — the same
  values the wiring checks already reconcile. Deriving them anywhere else is how the
  record drifts. Note the gate arbiter is not readable from the manifest alone: the
  runner PATH lives in the hook config, which is exactly why the checker derives it the
  same way the runner-pinning checks do rather than from `hookRunner` alone.
- The non-delegable floor is fixed: the §4.7.1 control plane, the ledger, the
  manifest, and the record itself. An arbiter's verdict on a change to the things
  that define what arbiters check is circular, so no verdict licenses that change.
- Wording is agent-agnostic. Naming a particular runtime's orchestration primitives
  dates the file to a release cycle, and a stale instruction read by an agent is worse
  than no instruction: it is followed.

What the record is NOT: a control. The checker verifies the arbiters are named
consistently with the manifest — not that they are sufficient, and not that any agent
read the file. That is the same `configured` versus `enforced` distinction §4.7 draws
about branch protection, and it belongs in the doctor's report the same way.
