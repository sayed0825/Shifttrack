import type { ReactNode } from 'react';

/**
 * Top-level Sentry.ErrorBoundary fallback. Deliberately plain — this only
 * renders when something has already gone wrong badly enough to crash the
 * whole app, so it should not depend on any app state or context.
 */
export default function ErrorFallback(): ReactNode {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg px-4 text-center">
      <div>
        <p className="font-display text-lg tracking-tight text-ink">Something went wrong</p>
        <p className="mt-1 text-sm text-ink/60">Please reload the page.</p>
      </div>
    </div>
  );
}
