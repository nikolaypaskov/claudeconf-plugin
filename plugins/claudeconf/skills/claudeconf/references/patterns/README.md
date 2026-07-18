# Reference Patterns

These files are **reference anchors, not mandates**. The claudeconf skill researches
current best practices for each project during execution and may diverge from the
patterns shown here. The patterns exist so Claude starts from known-good tool choices
and understands the determinism/tiering conventions established by the archived CLI
prototype — not to constrain what the skill is allowed to generate.

Concretely:

- Each per-stack file shows the tool-per-milestone + tier shape that the CLI prototype
  used. That shape is a starting point; if a project already uses a different formatter
  or linter with equivalent coverage, the skill should use the project's existing tool.
- The tiering conventions (edit → pre-commit → pre-push → gate → CI) and the
  blocking/advisory rules come from `constitution.md` and ARE fixed. The specific tools
  that fill each slot are not.
- The security patterns (semgrep config path, trufflehog flags) capture conventions that
  make scans deterministic and network-free; those conventions should be preserved even
  when the exact ruleset path differs.

Use these files as orientation, not as a checklist to copy verbatim.
