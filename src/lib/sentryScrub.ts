import type { Event as SentryEvent, Breadcrumb } from '@sentry/react';

// Sentry is a third party, and this app's error payloads can easily carry
// staff personal data: emails, names, clock-in coordinates, and free-text
// manager notes. This strips what it can before an event ever leaves the
// browser. It is not exhaustive — arbitrary free text elsewhere in a stack
// trace or console message is not scanned word-by-word for a person's
// name — but it covers every structured field the app actually reads or
// writes, plus the query-string shape Supabase's REST API uses for filters
// (e.g. `?email=eq.jane%40example.com`), which is the most likely place an
// email/coordinate/name leaks into a captured request URL.

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Column names, across every table, that hold an email, a name, a
// coordinate, or free-text note/comment content.
const SENSITIVE_KEYS = new Set([
  'email',
  'first_name',
  'firstname',
  'full_name',
  'fullname',
  'name',
  'latitude',
  'longitude',
  'clock_in_latitude',
  'clock_in_longitude',
  'address',
  'note_text',
  'comment_text',
]);

// The same field names as they appear in a Supabase PostgREST filter
// query string: `column=operator.value`.
const SENSITIVE_PARAM_PATTERN = new RegExp(
  `(${Array.from(SENSITIVE_KEYS).join('|')})=[^&\\s]*`,
  'gi'
);

function redactString(value: string): string {
  return value.replace(EMAIL_PATTERN, '[redacted-email]').replace(SENSITIVE_PARAM_PATTERN, '$1=[redacted]');
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : scrubValue(inner);
    }
    return out;
  }
  return value;
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = { ...breadcrumb };

  if (typeof next.message === 'string') {
    next.message = redactString(next.message);
  }

  const url = typeof next.data?.url === 'string' ? next.data.url : null;
  if (url && url.includes('employee_notes')) {
    // Manager notes are unstructured free text and can contain far more
    // than the recognised fields above — drop the request data entirely
    // rather than try to redact it field by field.
    next.data = { url: '[employee_notes request omitted]' };
  } else if (next.data) {
    next.data = scrubValue(next.data) as Record<string, unknown>;
  }

  return next;
}

/** Shared by both beforeSend and beforeSendTransaction. */
export function scrubSentryEvent<T extends SentryEvent>(event: T): T {
  if (event.message) event.message = redactString(event.message);

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((v) => ({
      ...v,
      value: v.value ? redactString(v.value) : v.value,
    }));
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  if (event.request) {
    event.request = {
      ...event.request,
      url: event.request.url ? redactString(event.request.url) : event.request.url,
      // Headers/cookies can carry the session's bearer token — drop
      // rather than scrub.
      headers: undefined,
      cookies: undefined,
      data: event.request.data ? scrubValue(event.request.data) : event.request.data,
    };
  }

  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;

  // The app never calls Sentry.setUser(); this only ever holds whatever
  // Sentry auto-attaches (e.g. an IP address). Never send it regardless.
  event.user = undefined;

  return event;
}
