// The methodology this whole suite depends on. Postgres RLS does not
// always surface a blocked operation as an error:
//
//  - A SELECT a policy excludes rows from isn't an error, it's a
//    successful response with an empty result.
//  - An UPDATE/DELETE whose USING clause excludes the target row isn't an
//    error either — it just matches zero rows and returns success.
//
// A suite that only checked `error !== null` would pass every "this must
// fail" case against a wide-open database, as long as nothing happened to
// throw. Every helper here checks actual database state instead (via the
// service-role admin client, which bypasses RLS), not just the response
// shape of the attempt.

interface MaybeRows<T> {
  data: T[] | null;
  error: unknown;
}

interface MaybeError {
  error: unknown;
}

/**
 * For a SELECT-shaped attempt: correct means checking for the absence of
 * rows, not the presence of an error — RLS usually returns an empty result
 * rather than erroring on a blocked read.
 */
export function expectNoRows<T>(result: MaybeRows<T>, label: string): void {
  if (result.error) return; // blocked with an explicit error is also fine
  const rows = result.data ?? [];
  if (rows.length !== 0) {
    throw new Error(`${label}: expected no visible rows, but got ${rows.length}: ${JSON.stringify(rows)}`);
  }
}

/**
 * For an INSERT/UPDATE/DELETE attempt that should be rejected: never trust
 * the response alone. `verifyUnchanged` re-reads the relevant state with
 * the admin client afterward and must throw if the write actually took
 * effect. This is the crux of the whole suite — skip this and a wide-open
 * table still passes.
 */
export async function expectWriteBlocked(
  label: string,
  attempt: () => PromiseLike<MaybeError>,
  verifyUnchanged: () => Promise<void>
): Promise<void> {
  await attempt();
  try {
    await verifyUnchanged();
  } catch (err) {
    throw new Error(`${label}: write was not blocked — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * For one of the four RPCs under explicit test (delete_staff_member,
 * approve_shift_swap, approve_shift_application, decide_overtime_claim):
 * each raises explicitly when the caller isn't authorised (see migration
 * 0007's notes on these four), so an error is expected here — but still
 * verify DB state afterward rather than trusting that alone, same
 * discipline as every write above.
 */
export async function expectRpcBlocked(
  label: string,
  attempt: () => PromiseLike<MaybeError>,
  verifyUnchanged: () => Promise<void>
): Promise<void> {
  const { error } = await attempt();
  if (!error) {
    throw new Error(`${label}: expected the RPC call to return an error, but it succeeded.`);
  }
  try {
    await verifyUnchanged();
  } catch (err) {
    throw new Error(`${label}: RPC errored but still had an effect — ${err instanceof Error ? err.message : String(err)}`);
  }
}
