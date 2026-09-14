import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.test' });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Copy .env.test.example to .env.test and fill it in — ` +
        `see README.md "Automated RLS tests" before running this suite.`
    );
  }
  return value;
}

export const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
export const SUPABASE_ANON_KEY = requireEnv('VITE_SUPABASE_ANON_KEY');

// This is the whole reason .env.test exists separately from .env: the
// service role key bypasses every RLS policy in the database. Refusing to
// start without it — rather than, say, falling back to the anon key — is
// deliberate: a silent fallback would make every negative test in this
// suite pass for the wrong reason (nothing being seeded/read/torn down at
// all, rather than RLS genuinely being exercised and holding).
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/**
 * Bypasses RLS entirely. Used only for fixture setup/teardown and for
 * re-reading DB state after a write a test expects to be rejected — never
 * to perform the operation a test is supposed to be exercising as a real
 * user. See assert.ts.
 */
export const adminClient: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
