// Conventional Commits, enforced at the `commit-msg` hook rather than merely requested
// (patterns/node.md). The ruleset is pinned through the two `@commitlint/*` devDependencies.
export default {
  extends: ['@commitlint/config-conventional'],
};
