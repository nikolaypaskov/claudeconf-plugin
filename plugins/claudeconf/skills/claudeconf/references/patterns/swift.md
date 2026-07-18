# Swift Pattern

> This is a starting point, not required. The tier placement and blocking/advisory
> semantics are fixed by `constitution.md`; the specific tools are not.

## Tool-per-milestone + tier

Mined from `src/policy/catalog/swift.ts` in the `cli-prototype` tag.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| format | edit | `swiftformat` | advisory (autofix) | changed `.swift` files |
| lint | pre-commit | `swiftlint lint --strict --quiet` | blocking | all |
| typecheck/build | pre-commit | `swift build` | blocking | all |
| unit (full) | pre-push | `swift test` | blocking | all |
| unit + coverage | gate | `swift test --enable-code-coverage` | blocking | all |

## Generic lesson: use SwiftPM, not Xcode

**Use `swift build` and `swift test`, NOT an Xcode scheme or `xcodebuild`.**

- SwiftPM commands (`swift build`, `swift test`) work for any project with a
  `Package.swift` manifest and require no per-project configuration — they are
  the right default for CI and hooks.
- `xcodebuild` requires specifying a scheme, workspace, and destination; those
  are project-specific and break on machines without the exact Xcode version.
  Reserve `xcodebuild` for projects that genuinely need it (e.g. iOS apps that
  target a simulator).
- `swift test --enable-code-coverage` produces an `.profdata` coverage report
  without any Xcode tooling.

## Notes

- `swiftformat` (autofix) and `swiftlint lint --strict` are separate tools.
  If the project is already on `swift-format` (Apple's official formatter) instead
  of the third-party `swiftformat`, use that — the tier mapping is the same.
- No `unit (changed)` step at pre-commit because swift has no equivalent of
  `vitest related`; `swift test` always runs the full suite.
- SAST and secret-scan come from `security.md` and are composed in regardless
  of stack.
