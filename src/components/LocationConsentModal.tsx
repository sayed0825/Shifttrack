import { useEffect, type ReactNode } from 'react';
import { MapPin } from 'lucide-react';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';

/**
 * Shown once per driver, before the native permission prompt ever fires —
 * Google Play requires this "prominent disclosure" screen ahead of a
 * background-location request, and it reads well to Apple's reviewers too,
 * so it's shown on iOS as well rather than only where it's mandatory.
 *
 * Tapping "Agree and continue" doesn't itself request anything — it just
 * lets the caller proceed to starting the watcher, whose own
 * `requestPermissions: true` is what actually opens the system prompt (see
 * addBackgroundLocationWatcher). The sequencing — this screen, then the OS
 * prompt — is what "prominent disclosure" means; reordering it defeats
 * the point.
 */
export default function LocationConsentModal({
  onAgree,
  onDismiss,
}: {
  onAgree: () => void;
  onDismiss: () => void;
}): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  useEffect(() => resetDocumentScroll, []);

  return (
    <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-primary/60 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-consent-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="location-consent-title" className="text-base font-semibold text-ink">
              Location while you're on a delivery shift
            </h2>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-sm text-ink/80">
          <p>
            While you're clocked in on a delivery shift, this app tracks your location — including while
            it's in the background or your phone is locked.
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>It's used to measure the mileage your pay is based on.</li>
            <li>It lets your manager see where drivers are, for dispatch.</li>
            <li>It only runs while you're clocked in on a delivery shift.</li>
            <li>It stops the moment you clock out.</li>
          </ul>
          <p className="text-xs text-ink/50">
            You'll see a system permission prompt next — choose "Always Allow" (or "Allow all the time")
            so tracking keeps working once the app is backgrounded.
          </p>
        </div>

        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={onAgree}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
          >
            Agree and continue
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-ink/60 hover:bg-bg"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
