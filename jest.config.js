/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {},
  // Every suite runs against a disposable HOME (see the helper) so state
  // paths derived from HOME at import time can never touch the developer's
  // real ~/.taxi, ~/.config/taxi, or ~/.cache/taxi.
  // setupFilesAfterEnv still runs before each test module is evaluated, while
  // also exposing afterAll so the per-suite HOME can be removed deterministically.
  // A run-scoped parent plus global teardown is the final cleanup barrier for
  // asynchronous work that recreates a suite HOME after its afterAll hook.
  globalSetup: '<rootDir>/tests/helpers/home-run-setup.cjs',
  globalTeardown: '<rootDir>/tests/helpers/home-run-teardown.cjs',
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/isolate-home.cjs'],
  // Stale git worktrees under `.claude/worktrees/*/` and the generated
  // `build/` bundle (build/mcpb/server/package.json), SwiftPM's `.build/`
  // products, and the generated
  // self-contained `Taxi.app` ship their own
  // package.json, which causes jest-haste-map to throw on duplicate module
  // names (`Cannot find module 'name'`) and jest's test discovery to run
  // pre-rebase versions of every suite. `testPathIgnorePatterns` only filters
  // discovery; `modulePathIgnorePatterns` is what suppresses haste scanning.
  // Both are needed.
  // Anchored to <rootDir> so running jest FROM a worktree checkout (whose
  // own path contains `/.claude/worktrees/…`) still discovers its tests —
  // an unanchored `/\.claude/` matched the checkout itself and silently
  // excluded every suite.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/\\.claude/',
    '<rootDir>/\\.build/',
    '<rootDir>/build/',
    '/Taxi\\.app/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/\\.claude/',
    '<rootDir>/\\.build/',
    '<rootDir>/build/',
    '/Taxi\\.app/',
  ],
  collectCoverageFrom: [
    'dist/**/*.js',
    '!dist/cli/**',
    '!dist/skills/builtins/**',
  ],
  coverageThreshold: {
    global: {
      statements: 46,
      branches: 40,
      functions: 42,
      lines: 46,
    },
  },
};
