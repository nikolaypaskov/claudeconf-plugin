# Execution modes (`generate` / `upgrade` / `refresh`)

`SKILL.md` selects the mode and owns the two stops a human sees. This file holds the
MECHANICS of the two non-default modes — what each one rewrites, in what order, and which
checker runs frame it. Read it in full before doing anything in `upgrade` or `refresh`;
`generate` needs nothing from here.

The ownership gate stays in `SKILL.md`, deliberately. It is the highest-stakes decision in
the procedure and it belongs where the procedure is read.

---

## `upgrade` — move a harness to a newer conformance profile

`references/migrations.md` is the procedure and the per-profile delta lists; this is the
frame around it.

### Order

1. **Read the recorded profile** from `.claudeconf/manifest.json`. That value, not the
   bundled constitution marker, is what the harness currently claims and is judged by.
2. **Check against the RECORDED profile**, enforcing default. Fix what fails BEFORE
   migrating — with the one carve-out below.
3. **The ownership gate** (`SKILL.md`). Nothing moves before it.
4. **Apply the delta list for recorded→next**, in sequence for a multi-profile jump: 2→4 is
   2→3 and then 3→4, never merged into one step. A merged jump skips the intermediate
   profile's checks, which is how a control the intermediate profile added gets missed.
5. **Dry run against the target**: `--profile <target>`. This runs the target profile's
   checks IN ADDITION TO the recorded profile's, never instead of them, so a dry run cannot
   hide a regression against what the harness claims today.
6. **Verify by executing** — the pre-commit tier and the gate tier both actually run green,
   every command executed rather than skipped (contract §3.4).
7. **Step 8 gate**, with the checker's per-check output as the evidence and the approved
   ownership classification re-presented alongside the diff.
8. **Bump `constitutionVersion` LAST.** Never first. The field selects the checks the
   harness is judged by, so a bump ahead of the controls makes every later verification
   answer the wrong question.

### The carve-out on step 2

Where the recorded-profile failure is the very thing the target profile's delta list EXISTS
to fix, it cannot be fixed first without doing the migration, and a literal reading of
step 2 means the migration can never start. Carry that failure in, name it in the report as
carried, and require it GREEN at the end.

Observed, not hypothetical: this project's own 3→4 move had exactly one profile-3 failure —
an unpinned hook runner — and pinning the runner is a profile-4 control.

### What `upgrade` must not do

- Never upgrade a harness nobody asked you to upgrade. A recorded profile behind the marker
  is grounds to OFFER, not to act.
- Never classify a job as managed because its name matches a managed token. See the
  ownership gate.
- Never write the new `constitutionVersion` before the controls it claims are in place.

---

## `refresh` — move tool VERSIONS inside the current profile

`refresh` never touches the profile, never re-classifies ownership, and never adds or
removes an artifact. It changes pins, and it changes ALL of them together.

Do Step 4's research and the registry confirmation for the requested tools only, then
rewrite the whole PIN CLOSURE in one change:

| where a pin lives | what to update |
| --- | --- |
| `.claudeconf/manifest.json` | profile ≤5: the milestone `version` (or the `tools[]` element), `ci.auditors[*].version`, `hookRunner.version`; profile 6: nothing — typed pins name a SOURCE, and the source is what moves |
| `.claudeconf/tools.lock.json` (profile 6) | the tool's `version`, `released` (from upstream), and every platform's `url`/`sha256`/`member`, copied from the release's own checksum file; refuse a release younger than the cooldown |
| `.claudeconf/bin/` (profile 6) | re-vendored WHOLESALE from the bundle when the skill ships a newer one, with `harnessScripts.version` moved to match — never edited in place |
| the tool's own config | any version field the config pins |
| the dependency lockfile | regenerated with the pinned package-manager version, frozen-install mode unchanged |
| hash-locked requirement files | recompiled against the RECORDED interpreter, with its hashes |
| the provisioning script | version variables AND the checksums, re-copied from the new release's own upstream checksum file — a digest computed from a download you already trust proves nothing |
| the CI workflow | image digests and the human-readable version comments beside them |
| the version-assertion script | the asserted versions, including the hook runner's |
| the hook runner | its `min_version`, and a re-run of the runner's `install` if the runner version moved |
| `.claudeconf/delegation.md` (profile ≥5) | nothing, unless the pinned RUNNER PATH moved — the record names the gate invocation, so a runner that relocates makes the record name an invocation that no longer exists |

A pin updated in one place and not the others is drift you introduced. The checker
reconciles pins across the manifest, the lockfile, the version-assertion script, the
provisioning script and the CI digest comments, so the drift is caught — but it is caught as
a FAIL on your own change, which is slower than doing the closure in one pass.

### Bounds worth stating when you report a refresh

- A version bump is an UPGRADE, not an idempotency violation. Contract §3.5's "identical
  inputs" includes the resolved versions.
- Re-confirm every new tool+version pair on its registry before writing it (contract §3.1,
  wiring-principles §7). A pinned wrong version looks deliberate.
- Bumping a pinned tool does not re-verify what that tool's own entry point resolves at run
  time (wiring-principles §1). Treat a tool that shells out to a companion as unpinned until
  the companion's resolution is pinned too.
