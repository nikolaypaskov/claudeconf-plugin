// tool-configs.mjs — which config file pins each known tool (PLAN.md AD4). Shared by the
// checker (A12, D7, work classification) and the vendored check-project-checks, so a bare
// `<tool>` command driven by a pinned config is judged the same way by both.
//
// Dependency-free: Node builtins only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** tool → candidate config files (a trailing `/` names a directory). */
export const TOOL_CONFIGS = {
  biome: ['biome.json', 'biome.jsonc'],
  eslint: [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.cjs',
  ],
  prettier: [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    'prettier.config.js',
    'prettier.config.mjs',
  ],
  tsc: ['tsconfig.json'],
  vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts'],
  jest: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'],
  playwright: ['playwright.config.ts', 'playwright.config.js'],
  tsup: ['tsup.config.ts', 'tsup.config.js', 'tsup.config.mjs'],
  ruff: ['ruff.toml', '.ruff.toml', 'pyproject.toml'],
  mypy: ['mypy.ini', '.mypy.ini', 'pyproject.toml', 'setup.cfg'],
  pytest: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'],
  uv: ['pyproject.toml'],
  semgrep: ['.claudeconf/rules/'],
};

/** The pinned config file for `tool` that exists under `root`, or null. */
export function pinnedConfigFor(root, tool) {
  const candidates = TOOL_CONFIGS[tool];
  if (!candidates) return null;
  return candidates.find((c) => !c.endsWith('/') && existsSync(join(root, c))) ?? null;
}
