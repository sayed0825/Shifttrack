// Shared tap-to-enable trigger for the temporary nav-drift debug overlay
// (src/components/DebugOverlay.tsx). Native app shells can't have a query
// param added by hand, so tapping the header org logo/name 5x in quick
// succession is the on-device equivalent of ?debug=1.

const TAPS_REQUIRED = 5;
const TAP_WINDOW_MS = 1200;

let tapCount = 0;
let lastTapAt = 0;
const listeners = new Set<() => void>();

export function onDebugTapTriggered(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordDebugTap(): void {
  const now = Date.now();
  if (now - lastTapAt > TAP_WINDOW_MS) tapCount = 0;
  lastTapAt = now;
  tapCount += 1;

  if (tapCount >= TAPS_REQUIRED) {
    tapCount = 0;
    listeners.forEach((listener) => listener());
  }
}
