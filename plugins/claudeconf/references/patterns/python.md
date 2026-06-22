# Python Pattern

> This is a starting point, not required. If the project already uses a different
> formatter, linter, or type checker with equivalent coverage, use that instead.
> The tier placement and blocking/advisory semantics are fixed by `constitution.md`;
> the specific tools are not.

## Tool-per-milestone + tier

Mined from `src/policy/catalog/python.ts` in the `cli-prototype` tag.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| format | edit | `ruff format` | advisory (autofix) | changed `.py` files |
| lint | pre-commit | `ruff check` | blocking | changed `.py` files |
| typecheck | pre-commit | `mypy .` | blocking | all |
| unit (full) | pre-push | `pytest -q` | blocking | all |
| dependency-audit | pre-push | `pip-audit` | advisory | all |
| unit + coverage | gate | `pytest --cov -q` | blocking | all |

## Notes

- **Ruff** handles both format and lint in one tool — avoids the Black + Flake8
  split. If the project is already on Black + isort + Flake8 that's fine; map
  them to the same tiers.
- The archived catalog has no `unit (changed)` step at pre-commit (unlike Node's
  `vitest related`). If the project's pytest suite is fast, add
  `pytest --testpaths <changed dirs> -q` at pre-commit for tighter feedback.
- `pip-audit` is advisory because audit results depend on the advisory database
  state; blocking on advisory findings causes spurious CI failures.
- mypy runs on `.` (all sources) even at pre-commit because incremental mypy runs
  on changed files only can miss transitive type errors.
- SAST and secret-scan come from `security.md` and are composed in at the harness
  level regardless of stack.
- The `build` milestone (e.g. `python -m build`, `hatch build`) is not in the
  archived prototype but is required by the harness contract. Add it at
  pre-push/CI.
- **Hook runner**: `pre-commit` (the Python tool) is the ecosystem-standard
  runner. Use it if the project already has `.pre-commit-config.yaml` and all
  three criteria in `constitution.md §5` hold; otherwise default to lefthook.
