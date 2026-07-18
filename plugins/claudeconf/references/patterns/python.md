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
  **prek** (the Rust `pre-commit` rewrite, same config format; adopted by CPython/
  FastAPI/Airflow) may be PRESERVED where a project already uses it explicitly — a
  bare `.pre-commit-config.yaml` alone does not select prek, and `pre-commit`-style
  runners populate hook environments from the network on a cold cache, so
  provisioning must be prewarmed to keep the no-runtime-fetch invariant
  (constitution §4.2).
- **Supply-chain admission (constitution §4.6), Python instantiation:** pip/uv have
  no native minimum-release-age setting, so the Dependabot/Renovate `cooldown`
  block carries the quarantine for the update path — record that install-path
  limitation per §4.6.2. Wheels do not execute install scripts; sdist builds do
  execute build backends, which is inherent to source installation (record, don't
  pretend to block). Commit the lock (`uv.lock`/`requirements.txt` with hashes) and
  install frozen (`uv sync --locked` / `pip install --require-hashes`).
- **ty** (Astral's type checker) is pre-1.0: an exact pin is perfectly
  deterministic, but beta maturity makes it unsuitable as the default BLOCKING
  typechecker — preserve it where already adopted, or offer as explicit
  opt-in/advisory alongside mypy/pyright.
