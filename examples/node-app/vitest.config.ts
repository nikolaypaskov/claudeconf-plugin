import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit suite only — the e2e suite has its own config (e2e/vitest.config.ts)
    // and is excluded here so unit and e2e runs stay separate.
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    // Determinism: the unit tier must be hermetic. No network, fixed timezone.
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
