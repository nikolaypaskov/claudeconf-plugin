# Elixir Pattern

> This is a starting point, not required. The tier placement and blocking/advisory
> semantics are fixed by `constitution.md`; the specific tools are not.

## Tool-per-milestone + tier

Mined from `src/policy/catalog/elixir.ts` in the `cli-prototype` tag.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| format | edit | `mix format` | advisory (autofix) | changed `.ex`/`.exs`/`.heex` files |
| lint | pre-commit | `mix credo --strict` | **advisory** | all |
| typecheck | pre-commit | — (none in prototype) | — | — |
| unit (stale) | pre-commit | `mix test --stale` | blocking | all |
| unit (full) | pre-push | `mix test` | blocking | all |
| typecheck/audit | pre-push | `mix dialyzer` | **advisory** | all |
| unit + coverage | gate | `mix test --cover` | blocking | all |

## Notes on advisory tasks

The archived catalog marks both `credo` and `dialyzer` as **advisory**, not
blocking, for a deliberate reason: they are provided by optional Mix dependencies
(`credo`, `dialyxir`). Because `mix` is always present but these tasks are not,
the harness engine cannot reliably detect whether the task is available — a missing
task would hard-fail the hook for any project that doesn't use it. When the project
DOES have these deps configured, the skill SHOULD promote them to blocking.

- **Credo**: if `{:credo, ...}` is in `mix.exs`, wire `mix credo --strict` as
  blocking at pre-commit.
- **Dialyzer**: if `{:dialyxir, ...}` is in `mix.exs`, wire `mix dialyzer` as
  blocking at pre-push. Note: first-run PLT build can take several minutes; cache
  the PLT in CI.

## Generic lessons

- `mix format` is built-in to Elixir and works for ANY project — no dep required.
- `mix test --stale` (pre-commit) avoids running the full suite on every commit
  while still catching regressions in the changed modules.
- **Sobelow is intentionally omitted.** Sobelow is Phoenix-specific SAST. The
  stack-agnostic security catalog (`security.md` — semgrep) covers SAST for all
  stacks including Elixir. Do not add sobelow unless the project is a Phoenix app.
- Elixir has no separate `build` step equivalent to `npm run build`; `mix compile`
  is implicit in all `mix test` / `mix credo` runs. Wire `mix compile` at
  pre-push/CI only if you need an explicit build artifact check.
