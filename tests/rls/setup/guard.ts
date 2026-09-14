import { adminClient } from './env';
import { ORG_A_SLUG, ORG_B_SLUG } from './constants';

/**
 * Refuses to run if the reserved test organisations already exist. This
 * suite runs against the live production Supabase project until a staging
 * one exists — seeding on top of, or tearing down, an org that's already
 * there (a previous run that crashed before cleanup, or an actual name
 * collision) is exactly the scenario that must never happen silently. A
 * teardown bug here would delete real payroll records.
 */
export async function assertNoCollision(): Promise<void> {
  const { data, error } = await adminClient
    .from('organisations')
    .select('id, name, slug')
    .in('slug', [ORG_A_SLUG, ORG_B_SLUG]);

  if (error) {
    throw new Error(`Could not check for existing test organisations before seeding: ${error.message}`);
  }

  if (data && data.length > 0) {
    const found = data.map((org) => `  - "${org.name}" (slug: ${org.slug}, id: ${org.id})`).join('\n');
    throw new Error(
      `Refusing to run: an organisation matching this suite's reserved test slug already exists:\n${found}\n\n` +
        `This is almost certainly leftover from a previous run whose teardown didn't complete ` +
        `(a crash, a killed process, a failed assertion during cleanup). Investigate and remove it ` +
        `manually via the Supabase SQL Editor before running this suite again — see README.md, ` +
        `"Automated RLS tests". Do not assume it is safe to reuse or delete automatically.`
    );
  }
}
