import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './env';
import type { TestUser } from './types';

/** A fresh anon-key client with no session — for the anonymous-access sweep. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Signs in as a fixture user with a dedicated client instance — never
 * shares a client/session across users, since that's how you'd
 * accidentally end up testing the wrong identity. Throws on failure: every
 * fixture user being able to sign in is a precondition the whole suite
 * depends on, not something each test should have to re-check.
 */
export async function signInAs(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) {
    throw new Error(`Could not sign in as ${user.email}: ${error.message}`);
  }
  return client;
}
