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
  - Hooks invoke project-local tools via `npx <tool>` or `node_modules/.bin/<tool>`
    (bare names exit 127 in a hook); global scanners (`trufflehog`/`semgrep`) stay
    bare. (§1)
  - Whole-repo `biome format .` / `lint .` must exclude generated + nested configs via
    `files.includes`, e.g. `["**", "!.claudeconf", "!.claude"]`. (§4)
  - `vitest run --coverage` needs `@vitest/coverage-v8` pinned to the `vitest` version. (§2)
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
  `run: npx commitlint --edit {1}`.
- **Supply-chain on `build`** (CI) — for anything published, generate an SBOM
  (e.g. `npx @cyclonedx/cyclonedx-npm --output-file sbom.json`) and attach build
  provenance with `actions/attest-build-provenance` (`id-token: write` +
  `attestations: write`, scoped to the build job only). See `ci-github-actions.md`.
