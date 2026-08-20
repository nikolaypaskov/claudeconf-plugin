# Node/TypeScript Pattern

> This is a starting point, not required. If the project already uses a different
> formatter or test runner with equivalent coverage, use that instead. The tier
> placement and blocking/advisory semantics are fixed by `constitution.md`; the
> specific tools are not.

## Tool-per-milestone + tier

Mined from `src/policy/catalog/node.ts` in the `cli-prototype` tag.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| format | edit | `biome format --write` | advisory (autofix) | changed JS/TS files |
| lint | pre-commit | `biome lint` | blocking | changed JS/TS files |
| typecheck | pre-commit | `tsc --noEmit` | blocking | all |
| unit (changed) | pre-commit | `vitest related --run` | blocking | changed JS/TS files |
| unit (full) | pre-push | `vitest run` | blocking | all |
| dependency-audit | pre-push | `npm audit --audit-level=high` | advisory | all |
| unit + coverage | gate | `vitest run --coverage` | blocking | all |

## Notes

- **Node instances of the generic `wiring-principles.md`:**
  - Hooks invoke project-local tools by their pinned path,
    `node_modules/.bin/<tool>` (bare names exit 127 in a hook); global scanners
    (`trufflehog`/`semgrep`) stay bare. NEVER `npx` / `npm exec`, in any form: an
    on-demand runner resolves by bin name and fetches an unrelated registry
    package when the devDependency is missing (observed for `tsc`, `biome`, and
    `lefthook`), and the no-install flag is no escape — a cached foreign package
    of the same name satisfies it. (§1)
  - Whole-repo `biome format .` / `lint .` must exclude generated + nested configs via
    `files.includes`, e.g. `["**", "!.claudeconf", "!.claude"]`. (§4)
  - `vitest run --coverage` needs `@vitest/coverage-v8` pinned to the `vitest` version. (§2)
- **A `.husky/` directory or a `lint-staged` block in `package.json` means the project
  ALREADY has a hook runner — never install lefthook alongside it.** husky points
  `core.hooksPath` at `.husky/` while lefthook writes `.git/hooks/*`, so whichever installed
  last is the one git runs and the other's checks silently stop. Offer either "migrate"
  (each existing command becomes a named job in the PROJECT-OWNED root `lefthook.yml` with a
  `projectChecks` entry; husky's and lint-staged's config and hooks are deleted in the same
  change; only a command the human ADOPTS at the review gate moves into the managed
  `.claudeconf/lefthook.yml`) or "preserve", the latter only if all three constitution §5
  criteria hold — which for husky/lint-staged they normally do not, since neither expresses
  the gate tier.
- **The Node RUNTIME is a pin too.** Emit the current Active LTS major (check
  nodejs.org's release schedule — an even major goes Active LTS in the October of its
  release year and Maintenance a year later) into a `.nvmrc` the workflow reads with
  `node-version-file:`, so a developer's shell and CI cannot disagree. `engines.node` is a
  different field: it is the project's SUPPORT floor, and with the managed
  `.npmrc engine-strict=true` a raised floor turns any of the project's own jobs on an older
  Node into a hard `EBADENGINE` install failure. Raise it only as a project decision.
- **Biome** handles both format and lint in one binary — avoids the
  ESLint + Prettier split. If the project is already on ESLint/Prettier that's
  fine; use those and skip the migration.
- `vitest related` at pre-commit keeps commit-time feedback fast by running
  only tests that import the changed files.
- `npm audit` is advisory at pre-push because audit results vary with the
  registry state; blocking on advisory findings causes spurious failures.
- SAST and secret-scan are NOT in this file — they come from `security.md`
  and are composed in at the harness level regardless of stack.
- The `build` milestone (e.g. `tsup build`, `tsc -p tsconfig.build.json`) is
  not in the archived prototype but is required by the harness contract. Add it
  at pre-push/CI with whatever build tool the project uses.
- **Conventional commits** — wire `commitlint` (`@commitlint/cli` +
  `@commitlint/config-conventional`, both pinned) at a `commit-msg` hook so commit
  messages are enforced, not merely requested. lefthook supports `commit-msg`:
  `run: node_modules/.bin/commitlint --edit {1}`.
- **Supply-chain on `build`** (CI) — for anything published, generate an SBOM
  (e.g. `@cyclonedx/cyclonedx-npm` as a pinned devDependency, invoked as
  `node_modules/.bin/cyclonedx-npm --output-file sbom.json`) and attach build
  provenance with `actions/attest-build-provenance` (`id-token: write` +
  `attestations: write`, scoped to the build job only). See `ci-github-actions.md`.
- **Supply-chain admission (constitution §4.6), npm/pnpm instantiation:**
  - Release-age quarantine on the INSTALL path: npm ≥11.10 supports
    `min-release-age` (days) + `min-release-age-exclude` in `.npmrc`; pnpm ≥11 has
    `minimumReleaseAge` (minutes; default 1440) + `minimumReleaseAgeExclude` in
    `pnpm-workspace.yaml`. Pair with the Dependabot/Renovate `cooldown` on the
    UPDATE path — each covers a bypass the other leaves open. Note npm silently
    ignores unknown config keys on older versions: record the required npm version.
  - Lifecycle scripts: pnpm denies dependency build scripts by default
    (`strictDepBuilds`, per-package `allowBuilds` allowlist — use it). npm offers
    only the all-or-nothing `ignore-scripts`, which also disables the project's OWN
    `prepare`/`prepack` hooks (e.g. `lefthook install`) — where that breaks the
    workflow, record the limitation per §4.6.2 instead of silently accepting
    default-allow.
  - Committed `package-lock.json` + `npm ci` (frozen, no fallback) — see
    wiring-principles §8.
- **Biome floor**: type-aware lint rules need Biome 2.5+ — that is a feature
  COMPATIBILITY FLOOR for research, not pin guidance; the harness still pins one
  exact researched version.
