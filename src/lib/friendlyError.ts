// Maps a Postgres/PostgREST error code to plain language a user can act on.
// A raw "new row violates row-level security policy for table ..." (or any
// other SQLSTATE text) is never acceptable in front of a user — it's an
// implementation detail, sometimes one that leaks table/column names.
const CODE_MESSAGES: Record<string, string> = {
  '42501': 'You do not have permission to do that.',
  '23505': 'That already exists.',
  '23503': 'That refers to something that no longer exists.',
  '23514': 'Those values are not valid together.',
};

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

function isPostgrestLike(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    'message' in error
  );
}

/**
 * Turns a Supabase/PostgREST error (from a `.from()`/`.rpc()` call, thrown
 * or returned as `{ error }`) into a message safe to show a user.
 *
 * Only errors that actually carry a Postgres/PostgREST `code` are
 * translated — a plain `Error` you threw yourself (e.g. "Your session has
 * expired") passes through unchanged, since that message was already
 * written for a user to read. Anything with an unrecognised code, or whose
 * message names an RLS policy, falls back to a generic message with the
 * raw error logged to the console instead of displayed.
 */
export function friendlyError(error: unknown, fallback: string = GENERIC_MESSAGE): string {
  if (isPostgrestLike(error)) {
    const known = CODE_MESSAGES[error.code];
    if (known) return known;

    if (/row-level security policy/i.test(error.message)) {
      return CODE_MESSAGES['42501'];
    }

    console.error(error);
    return fallback;
  }

  if (error instanceof Error) return error.message;

  return fallback;
}
