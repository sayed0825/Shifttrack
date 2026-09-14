import type { TestProject } from 'vitest/node';
import { assertNoCollision } from './setup/guard';
import { createFixtures } from './setup/fixtures';
import { teardownFixtures } from './setup/teardown';
import type { FixtureManifest } from './setup/types';

// Runs once for the whole suite (not per test file), since fixture setup —
// creating auth users across two organisations plus dozens of seeded rows —
// is expensive and every test file needs the same fixtures. Vitest's
// provide()/inject() carries the (JSON-serialisable) result across the
// process boundary into each test file; see setup/types.ts.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Importing ./setup/env (transitively, via guard/fixtures) validates
  // SUPABASE_SERVICE_ROLE_KEY is present and throws immediately if not —
  // see that file for why a missing key must hard-fail, not fall back.
  await assertNoCollision();

  const fixtures: FixtureManifest = await createFixtures();
  project.provide('fixtures', fixtures);

  return async () => {
    await teardownFixtures(fixtures);
  };
}
