# Contributing

Thanks for your interest in claudeconf.

## This repository

This is the **distribution** repository for the `claudeconf` Claude Code plugin: the
skill under `plugins/claudeconf/`, a self-hosted marketplace manifest, and `examples/`
that are validated on CI.

## Issues and feedback

Bug reports, tool-research corrections, and stack-specific feedback are welcome — open an
issue. If you ran the skill on a project and the generated harness needed a fix, that is
especially useful: the goal is to fold the lesson back into the generic principles rather
than special-case a stack.

## Changes

- Keep the skill **technology-agnostic** — encode lessons as generic principles in
  `references/wiring-principles.md`, not as per-stack presets.
- Keep examples valid: `node scripts/validate-examples.mjs` must pass.
- Use conventional-commit messages.
