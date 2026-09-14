import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.js: this suite is a Node script
// hitting a live Supabase project over the network, not a browser/component
// test, so it has no business sharing the React plugin, Tailwind plugin, or
// the app's `@` alias.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rls/**/*.test.ts'],
    globalSetup: ['tests/rls/global-setup.ts'],
    // Real network calls (auth, Postgres, 5 concurrent test users) are far
    // slower than in-process unit tests. Fixture setup/teardown in
    // particular can take a while — creating and deleting ~10 auth users
    // plus dozens of seeded rows.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Table-driven cross-org/anonymous sweeps hit the same project from many
    // files at once; keep it modest so Supabase's connection pool and auth
    // rate limits aren't hammered by parallel workers.
    fileParallelism: false,
  },
});
