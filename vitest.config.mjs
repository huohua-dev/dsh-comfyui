// Unit/integration tests for the host half (src/*.ts) and the client card.
// The legacy scripts/test-*.mjs suites run separately against lib/ (see
// scripts/run-legacy-tests.mjs), wired together by `npm test`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
