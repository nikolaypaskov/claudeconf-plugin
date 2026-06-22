# Kotlin Pattern

> This is a starting point, not required. The tier placement and blocking/advisory
> semantics are fixed by `constitution.md`; the specific tools are not.

## Tool-per-milestone + tier

Mined from `src/policy/catalog/kotlin.ts` in the `cli-prototype` tag.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| format | edit | `ktlint -F` | advisory (autofix) | changed `.kt`/`.kts` files |
| lint | pre-commit | `ktlint` | blocking | changed `.kt`/`.kts` files |
| unit + build | pre-push | `./gradlew test --quiet` | blocking | all |
| unit + build | gate | `./gradlew test --quiet` | blocking | all |

## Generic lesson: use `./gradlew`, not Android-specific tasks

**Always invoke the project-local Gradle wrapper (`./gradlew`), and use the
universal `test` task — not Android-only variants like `testDebugUnitTest`.**

- `./gradlew test` is the standard cross-project task defined by the Kotlin/JVM
  convention plugin and works for JVM server apps, libraries, and multi-module
  projects.
- `testDebugUnitTest` / `testReleaseUnitTest` are Android build-variant tasks
  that only exist in Android projects and require an Android SDK. Using them as
  the default would break all non-Android Kotlin projects.
- The archived catalog uses `./gradlew` (project-local wrapper) rather than a
  globally-installed `gradle` binary to ensure the build uses the exact Gradle
  version pinned in `gradle/wrapper/gradle-wrapper.properties`.

## Notes

- The archived catalog has no separate `typecheck` step because Kotlin compilation
  (invoked by `./gradlew test`) already performs type-checking. If the project has
  a large compilation step that is slow at pre-commit, add
  `./gradlew compileKotlin --quiet` at pre-commit and leave the full `test` at
  pre-push.
- No `dependency-audit` in the archived catalog. Gradle has `./gradlew dependencyCheckAnalyze`
  (OWASP) which can be added as advisory at pre-push if the project has the plugin.
- SAST and secret-scan come from `security.md` and are composed in regardless
  of stack.
- Detekt (static analysis for Kotlin) was listed in the check catalog but not in
  the archived prototype's KOTLIN_CHECKS. Add `./gradlew detekt` at pre-commit as
  blocking if the project has detekt configured.
